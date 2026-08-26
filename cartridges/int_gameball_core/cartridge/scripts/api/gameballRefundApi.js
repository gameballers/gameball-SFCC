'use strict';

var OrderMgr = require('dw/order/OrderMgr');
var Currency = require('dw/util/Currency');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var gameballMoney = require('*/cartridge/scripts/util/gameballMoney');
var lineItemPayload = require('*/cartridge/models/payload/lineItem');
var refundStateStore = require('*/cartridge/scripts/refund/refundStateStore');
var refundGate = require('*/cartridge/scripts/refund/refundGate');
var refundDelivery = require('*/cartridge/scripts/refund/refundDelivery');

// CRITICAL - DO NOT register a dw.order.payment.refund hook for this, ever,
// under any framing.
//
// dw.order.payment.refund(invoice : Invoice) : Status is a
// SINGLE-IMPLEMENTATION, VALUE-RETURNING SERVICE HOOK on
// dw.order.hooks.PaymentHooks - it is NOT a broadcast notification. The
// first cartridge on the path wins and every other implementation is never
// called. On a post-processing-active instance (the only kind of instance
// where it fires at all), int_gameball_core or int_gameball_sfra sitting
// ahead of the merchant's real payment cartridge would SHADOW the PSP's own
// refund implementation and stop refunds from being issued at the payment
// processor - the shopper's money would not move. That hook belongs to the
// merchant's real payment service provider and to nothing else.
//
// Detection is a POLLING JOB (custom.Gameball.RefundDetect, see
// scripts/job/refund/detectRefunds.js), never an event hook. This module is
// the OTHER half: the public, versioned entry point any OMS/PSP/middleware
// integration the merchant writes calls directly to push a refund of any
// shape into Gameball - a full reversal, a partial, a chargeback, a
// shipping/tax/adjustment-only refund - within seconds, for everything the
// polling job structurally cannot see (build-plan section 7.3's coverage
// number: the automatic path catches roughly 10-20% of refund events by
// count and less by value; see docs/refunds-integration-guide.md).

var VALID_KINDS = { RETURN: true, CANCELLATION: true, CHARGEBACK: true, SHIPPING: true, TAX: true, ADJUSTMENT: true };
var EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
var EXTERNAL_ID_MAX_LENGTH = 64;
var REASON_MAX_LENGTH = 200;

/**
 * The order currency's minor unit (10^-fractionDigits) - e.g. 0.01 for a
 * 2-decimal currency, 1 for a 0-decimal currency like JPY. Duplicates the
 * three-line currency-lookup gameballMoney.roundToCurrency already performs
 * internally, rather than adding a third export to gameballMoney.js:
 * arbitration section 4.13 scopes this item's append to that frozen,
 * append-only file to exactly prorateToNumber/subtractToNumber, and a
 * currency-precision constant used by exactly one caller in one other file
 * does not earn a third (mirrors the resolveAttemptIdentity/
 * isGameballEnabled duplication pattern already established elsewhere in
 * this cartridge rather than growing a shared export for a few lines).
 * @param {string} currencyCode
 * @returns {number}
 */
function minorUnit(currencyCode) {
    var digits = 2;

    try {
        var currency = currencyCode ? Currency.getCurrency(currencyCode) : null;
        if (currency !== null && currency !== undefined) {
            digits = currency.getDefaultFractionDigits();
        }
    } catch (e) {
        digits = 2;
    }

    return Math.pow(10, -digits);
}

/**
 * @param {string} reason
 * @returns {{accepted: boolean, refundEventId: null, refundTransactionId: null, status: string, reason: string}}
 */
function rejected(reason) {
    return { accepted: false, refundEventId: null, refundTransactionId: null, status: 'REJECTED', reason: reason };
}

/**
 * Shape/range validation only - NOT resolvability against a real order
 * (that needs the order in hand, checked separately by
 * validateLineItemsResolve below, after OrderMgr.getOrder). Every failure
 * here means the call touches NOTHING: no order read, no ledger read, no
 * Transaction.wrap (section 5.1 step 2).
 * @param {Object} options
 * @returns {string|null} an INVALID_* reason, or null when valid
 */
function validateShape(options) {
    if (!options || typeof options !== 'object') {
        return 'INVALID_INPUT';
    }

    if (!options.orderNo || typeof options.orderNo !== 'string') {
        return 'INVALID_INPUT';
    }

    if (options.kind !== undefined && !VALID_KINDS[options.kind]) {
        return 'INVALID_KIND';
    }

    if (options.externalRefundId !== undefined) {
        var id = options.externalRefundId;
        if (typeof id !== 'string' || id.length < 1 || id.length > EXTERNAL_ID_MAX_LENGTH || !EXTERNAL_ID_PATTERN.test(id)) {
            return 'INVALID_EXTERNAL_ID';
        }
    }

    // full === true XOR a finite, positive refundAmount - neither, both,
    // zero, negative or NaN are all rejected the same way (section 5.1 step 2).
    var hasFull = options.full === true;
    var hasAmount = typeof options.refundAmount === 'number' && isFinite(options.refundAmount) && options.refundAmount > 0;
    if (hasFull === hasAmount) {
        return 'INVALID_AMOUNT';
    }

    if (options.lineItems !== undefined) {
        if (!Array.isArray(options.lineItems) || !options.lineItems.length) {
            return 'INVALID_LINE_ITEM';
        }

        for (var i = 0; i < options.lineItems.length; i++) {
            var li = options.lineItems[i];
            if (!li || typeof li.productLineItemUUID !== 'string' || !li.productLineItemUUID
                    || typeof li.quantity !== 'number' || !isFinite(li.quantity) || li.quantity <= 0) {
                return 'INVALID_LINE_ITEM';
            }
        }
    }

    if (options.occurredAt !== undefined) {
        if (!(options.occurredAt instanceof Date) || isNaN(options.occurredAt.getTime())) {
            return 'INVALID_DATE';
        }
    }

    return null;
}

/**
 * Resolvability check for caller-supplied line items, run once the order is
 * in hand: every productLineItemUUID must resolve to a real, built,
 * non-option product line item on THIS order. If any does not, the WHOLE
 * refund is rejected here rather than being recorded and sent with items
 * silently missing - a refund payload with a dropped item under-reverses
 * and produces no Gameball-side error (section 4.2).
 * @param {dw.order.Order} order
 * @param {{productLineItemUUID: string, quantity: number}[]} requested
 * @returns {boolean} true when every requested UUID resolves
 */
function requestedLineItemsResolve(order, requested) {
    try {
        var built = lineItemPayload.build(order);
        var byUUID = {};
        var i;

        for (i = 0; i < built.length; i++) {
            var uuid = built[i].extra && built[i].extra.sfccUUID;
            if (uuid) {
                byUUID[uuid] = true;
            }
        }

        for (i = 0; i < requested.length; i++) {
            if (!byUUID[requested[i].productLineItemUUID]) {
                return false;
            }
        }

        return true;
    } catch (e) {
        // A build failure here means the resolvability check itself could
        // not run - treated as "does not resolve" (the conservative
        // direction) rather than silently letting an unverified selection
        // through.
        return false;
    }
}

/**
 * Computes the refundAmount to send for a partial refund whose caller
 * supplied specific line items - the proration formula from build-plan
 * section 7.5 / spec section 5.5, using getProratedPrice() (never
 * getAdjustedPrice(true) - see the comment inline below for why that is not
 * cosmetic) via gameballMoney.prorateToNumber.
 *
 * When lineItems were supplied, this computed figure is AUTHORITATIVE and
 * overrides options.refundAmount: the per-unit proration is a more
 * trustworthy "what was actually paid for these units" figure than a
 * merchant-typed number, and per-item proration is the only reason
 * gameballMoney's prorateToNumber/subtractToNumber exports exist at all.
 * When no lineItems were supplied there is nothing to prorate, and
 * options.refundAmount (already shape-validated as a finite number > 0) is
 * used as-is.
 *
 * The final refund on an order absorbs the arithmetic remainder rather than
 * a recomputed share (section 5.5's own rule): once the residue left under
 * gbTrackedTotalPaid rounds to zero or less at the currency's own
 * precision, this returns exactly gbTrackedTotalPaid - gbRefundedAmount
 * rather than the (possibly fractionally short) prorated sum, so three
 * partials against one order sum to the tracked total exactly instead of
 * leaving a rounding residue that either trips the cumulative guard on the
 * last refund or lets a cent-level overshoot through.
 *
 * @param {dw.order.Order} order
 * @param {Object} options - submitRefund's own options
 * @returns {number}
 */
function computeRefundAmount(order, options) {
    if (!options.lineItems || !options.lineItems.length) {
        // Rounded here even though validateShape already required a finite
        // number > 0 - shape validation checks range, not precision. Every
        // OTHER figure this function can return (the lineItems-proration
        // branch below, and the remainder-absorption path) is already
        // currency-rounded; a caller-supplied 12.347 on a 2-decimal currency
        // (or any fractional value on a 0-decimal one like JPY) must not be
        // the one shape that reaches entry.refundAmount/the outbound payload
        // unrounded.
        return gameballMoney.roundToCurrency(options.refundAmount, order.getCurrencyCode());
    }

    var currencyCode = order.getCurrencyCode();
    var total = 0;

    try {
        var byUUID = {};
        var pliIterator = order.getAllProductLineItems().iterator();
        while (pliIterator.hasNext()) {
            var pli = pliIterator.next();
            try {
                byUUID[pli.getUUID()] = pli;
            } catch (e) {
                // no UUID on this line item - it can never be a caller
                // selection target, nothing to index
            }
        }

        for (var i = 0; i < options.lineItems.length; i++) {
            var requested = options.lineItems[i];
            var matchedPli = byUUID[requested.productLineItemUUID];
            if (!matchedPli) {
                continue; // eslint-disable-line no-continue
            }

            var quantityValue = lineItemPayload.getQuantityValue(matchedPli);
            if (quantityValue > 0) {
                // getProratedPrice(), never getAdjustedPrice(true): the
                // latter prorates only order-level adjustments, leaving a
                // Buy-X-Get-Y discount concentrated on the Y line - refunding
                // X then over-claws (we reverse more than the shopper
                // effectively paid) and refunding Y under-claws (the Y line
                // looks free). getProratedPrice() spreads BOTH BXGY and
                // order-level discounts across every affected line, so each
                // unit's refund value matches what was actually paid for it.
                total += gameballMoney.prorateToNumber(matchedPli.getProratedPrice(), requested.quantity, quantityValue, currencyCode);
            }
        }
    } catch (e) {
        Logger.error('gameballRefundApi~computeRefundAmount: proration failed for order {0}: {1}', order.getOrderNo(), e && e.message);
    }

    if (options.kind === 'SHIPPING') {
        total += gameballMoney.toNumber(order.getShippingTotalPrice());
    } else if (options.kind === 'TAX') {
        total += gameballMoney.toNumber(order.getTotalTax());
    }

    var refundedSoFar = Number(order.custom.gbRefundedAmount) || 0;
    var trackedTotal = Number(order.custom.gbTrackedTotalPaid);

    if (isFinite(trackedTotal) && trackedTotal > 0) {
        // Absorb the remainder ONLY when it is genuine sub-minor-unit
        // rounding drift (build-plan/spec section 5.5: "under one minor
        // unit"), never a real overshoot of any larger size.
        //
        // Compared on the RAW, unrounded residual, not a pre-rounded one: the
        // previous shape here rounded the residual to currency precision
        // before testing <= 0, which maps any raw residual from half a minor
        // unit up to just under a full one UP across the zero boundary and
        // so silently SKIPS absorption for exactly the drift band this logic
        // exists to close - a three-way 3.333/3.333/3.334 split against a
        // 10.00 total left the cumulative refund one cent short
        // (9.99 instead of 10.00) because the closing refund's raw residual
        // (0.006) rounded to 0.01 and never triggered the old `residual <= 0`
        // check.
        //
        // Bounded on BOTH sides by one minor unit, not just `residual <= 0`
        // with no floor: the old shape absorbed an overshoot of ANY
        // magnitude, so a second, overlapping partial refund (a caller
        // retry that dropped its externalRefundId, or two independently
        // issued partials) had its computed amount silently clamped down to
        // whatever remained under the ceiling - which bypasses
        // refundGate.evaluate's own exceeds_tracked_total guard entirely,
        // since the amount handed to it was already pre-shrunk to fit, and
        // under-reverses the customer's points balance with a clean SENT
        // response and no operator-visible signal anywhere. A genuine
        // overshoot beyond one minor unit is left completely UNCLAMPED here
        // on purpose, so it flows unchanged into refundGate.evaluate, which
        // then correctly routes it to MANUAL_REVIEW instead of silently
        // truncating it (build-plan section 7.5: "never clamped and never
        // sent").
        var unit = minorUnit(currencyCode);
        var rawResidual = trackedTotal - refundedSoFar - total;
        if (rawResidual < unit && rawResidual > -unit) {
            total = gameballMoney.subtractToNumber(trackedTotal, refundedSoFar, currencyCode);
        }
    }

    return gameballMoney.roundToCurrency(total, currencyCode);
}

/**
 * Records a refund against an SFCC order and sends it to Gameball.
 *
 * This is the supported, versioned integration point for OMS, PSP and
 * middleware refunds - the only path by which a refund that SFCC itself
 * cannot see (a post-shipment return, a partial, an appeasement, a
 * chargeback, an Adyen Customer Area refund) can ever reach Gameball.
 * Breaking its shape requires a major cartridge version bump.
 *
 * Guarantees:
 *  - NEVER throws into the caller. Every failure is a return value.
 *  - Records the refund durably on the order BEFORE any network call, so an
 *    outbound failure is retried by the Gameball Refund Detector job rather
 *    than lost. (Deviation from build-plan section 7.7's literal "never
 *    performs the HTTP call inline" wording, stated once here rather than
 *    duplicated at every call site: this project's binding scope decision
 *    skips the outbound queue Custom Object, so there is nothing to enqueue
 *    into. The two properties that made "enqueue first" valuable - durability,
 *    and an idempotency key allocated before any network I/O - are both
 *    preserved exactly by recording the entry first; what is lost is the
 *    latency guarantee for the caller's own thread. Pass deferSend:true to
 *    recover it.)
 *  - Idempotent on externalRefundId: calling twice with the same value
 *    returns the existing refund and makes no second call, no second entry,
 *    no second sequence number. This is what makes it safe to wire into a
 *    PSP webhook that may be delivered more than once.
 *  - Issues AT MOST ONE outbound HTTP call. A caller looping inside one
 *    storefront request must pass deferSend:true - the storefront quota is
 *    16 HTTPClient sends per request (P5).
 *
 * @param {Object} options
 * @param {string} options.orderNo - required, the SFCC order number
 * @param {string} [options.kind=RETURN] - RETURN|CANCELLATION|CHARGEBACK|SHIPPING|TAX|ADJUSTMENT
 * @param {boolean} [options.full=false] - true omits refundAmount => Gameball reverses the whole transaction
 * @param {number} [options.refundAmount] - required when full is not true; order currency, > 0.
 *   Overridden by a lineItems-based proration when lineItems is also supplied - see computeRefundAmount.
 * @param {string} [options.externalRefundId] - 1-64 chars of [A-Za-z0-9._:-]; the idempotency key
 * @param {Date} [options.occurredAt=new Date()] - becomes transactionTime, stamped once
 * @param {Object[]} [options.lineItems] - [{productLineItemUUID: string, quantity: number}]
 * @param {string} [options.reason] - stored on the order ledger for audit; NEVER sent (Gameball has no reason field)
 * @param {boolean} [options.deferSend=false] - record only; the hourly job delivers it
 * @returns {{accepted: boolean, refundEventId: (string|null), refundTransactionId: (string|null),
 *            status: string, reason: (string|undefined), duplicate: (boolean|undefined)}}
 *   status is one of SENT | DUPLICATE | PENDING | WAITING_FOR_ORDER | MANUAL_REVIEW | FAILED | REJECTED
 */
function submitRefund(options) {
    try {
        var validationError = validateShape(options);
        if (validationError) {
            return rejected(validationError);
        }

        var order = OrderMgr.getOrder(options.orderNo);
        if (!order) {
            return rejected('ORDER_NOT_FOUND');
        }

        if (options.lineItems && options.lineItems.length && !requestedLineItemsResolve(order, options.lineItems)) {
            return rejected('INVALID_LINE_ITEM');
        }

        var ledger = refundStateStore.readLedger(order);
        if (ledger === null) {
            // Never proceed on an unreadable ledger - proceeding would lose
            // every idempotency record already on this order (section 5.1
            // step 4). Written through refundStateStore's own rollup-state
            // helper, not a local Transaction.wrap - that module is the sole
            // writer of every Order.custom.gbRefund* attribute.
            refundStateStore.setRollupState(order, 'MANUAL_REVIEW', 'ledger_unreadable');
            Logger.error('gameballRefundApi~submitRefund: gbRefundLedger on order {0} will not parse - refusing every further refund on this order until a human fixes it',
                order.getOrderNo());
            return { accepted: false, refundEventId: null, refundTransactionId: null, status: 'MANUAL_REVIEW', reason: 'LEDGER_UNREADABLE' };
        }

        if (options.externalRefundId) {
            var existing = refundStateStore.findByExternalId(ledger, options.externalRefundId);
            if (existing) {
                return {
                    accepted: true,
                    refundEventId: existing.refundTransactionId,
                    refundTransactionId: existing.refundTransactionId,
                    status: existing.state,
                    duplicate: true
                };
            }
        }

        var full = options.full === true;
        var refundAmount = full ? null : computeRefundAmount(order, options);

        // A non-full refund whose computed amount is <= 0 is an invalid
        // state, not a valid zero-value refund - validateShape already
        // requires a positive options.refundAmount, but lineItems (when
        // supplied) OVERRIDE that entirely with a per-item proration
        // (computeRefundAmount's own JSDoc), and that proration can
        // legitimately sum to exactly 0: a 100%-discounted promo item, a BOGO
        // free unit, or a bonus/NOT_AVAILABLE-priced product all prorate to
        // Money(0). Rejected here, before any ledger entry is ever
        // allocated, rather than letting a zero-value entry.refundAmount
        // reach refundPayload.build() - Gameball's contract has no documented
        // meaning for a literal `refundAmount: 0` on the wire (omitting the
        // key entirely means "full reversal" per build-plan section 13.5),
        // so this is exactly the state H31 ("omit rather than send a bad
        // value") says must never be sent, and it can never legitimately
        // occur - a PARTIAL refund of nothing is not a refund.
        if (!full && (!isFinite(refundAmount) || refundAmount <= 0)) {
            return rejected('INVALID_AMOUNT');
        }

        var gate = refundGate.evaluate(order, { full: full, refundAmount: refundAmount });

        if (!gate.shouldSend && gate.reason !== 'order_not_tracked') {
            if (gate.skipState) {
                refundStateStore.setRollupState(order, gate.skipState, gate.reason);
            }
            return rejected(gate.reason);
        }

        var spec = {
            kind: options.kind || 'RETURN',
            full: full,
            refundAmount: refundAmount,
            externalRefundId: options.externalRefundId || null,
            occurredAt: options.occurredAt || null,
            lineItems: full ? null : (options.lineItems || null),
            reason: options.reason ? String(options.reason).substring(0, REASON_MAX_LENGTH) : null,
            source: 'SUBMIT_REFUND',
            state: gate.reason === 'order_not_tracked' ? 'WAITING_FOR_ORDER' : 'PENDING'
        };

        var allocation = refundStateStore.allocateEntry(order, spec);

        if (allocation.error) {
            if (allocation.error === 'CONCURRENT_MODIFICATION') {
                // Do NOT swallow this as success - the caller must retry.
                return rejected('CONCURRENT_MODIFICATION');
            }
            return { accepted: false, refundEventId: null, refundTransactionId: null, status: 'MANUAL_REVIEW', reason: allocation.error };
        }

        var entry = allocation.entry;

        if (!allocation.created) {
            // A concurrent caller inserted the same externalRefundId between
            // this function's own dedupe check above and allocateEntry's
            // re-check inside its transaction.
            return {
                accepted: true,
                refundEventId: entry.refundTransactionId,
                refundTransactionId: entry.refundTransactionId,
                status: entry.state,
                duplicate: true
            };
        }

        if (options.deferSend === true || entry.state === 'WAITING_FOR_ORDER') {
            // The next Gameball Refund Detector run picks this up via
            // gbRefundPendingAt - no HTTP call from this thread.
            return {
                accepted: true,
                refundEventId: entry.refundTransactionId,
                refundTransactionId: entry.refundTransactionId,
                status: entry.state
            };
        }

        var outcome = refundDelivery.deliverEntry(order, entry);

        return {
            accepted: true,
            refundEventId: entry.refundTransactionId,
            refundTransactionId: entry.refundTransactionId,
            status: outcome.state
        };
    } catch (e) {
        Logger.error('gameballRefundApi~submitRefund failed: {0}', e && e.message);
        return { accepted: false, refundEventId: null, refundTransactionId: null, status: 'REJECTED', reason: 'INTERNAL_ERROR' };
    }
}

module.exports = {
    submitRefund: submitRefund
};
