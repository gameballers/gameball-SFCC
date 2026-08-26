'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var lineItemPayload = require('*/cartridge/models/payload/lineItem');

// CRITICAL: refund DETECTION must never be wired via a dw.order.payment.refund
// hook. dw.order.payment.refund(invoice : Invoice) : Status is a
// single-implementation, value-returning SERVICE hook - not a broadcast
// notification. The first cartridge on the path wins and every other
// implementation is never called, so registering it here would SHADOW the
// merchant's real payment service provider and stop refunds from being
// issued at the processor - the shopper's money would not move. See
// gameballRefundApi.js, which carries the full warning and is the module
// that must never register it. This module only builds a payload once a
// refund has already been recorded by refundStateStore.js.
//
// TODO (build-plan section 7.8, not this item): scope/precedence semantics
// of a general merchant-configurable refund reason taxonomy remain open -
// Gameball's endpoint has no `reason` field at all (section 4.4 below), so
// there is nothing to design here until Gameball adds one.

/**
 * Sanity-checks a phone number: non-empty and containing at least one digit.
 * Mirrors orderPayload.js's isPlausiblePhone - duplicated rather than
 * imported because that function is private to orderPayload.js and this
 * module deliberately makes ZERO edits to that file (section 9 - the most
 * contended payload file in the cartridge).
 * @param {string} phone
 * @returns {boolean}
 */
function isPlausiblePhone(phone) {
    return !!phone && typeof phone === 'string' && /\d/.test(phone);
}

/**
 * Billing-address-only mobile resolution - deliberately NO shipping-address
 * fallback, unlike orderPayload.js's resolveMobile. Section 7.4's mapping
 * for the refund endpoint is billing-only; the asymmetry with order tracking
 * is intentional and documented there, not a bug to reconcile.
 * @param {dw.order.Order} order
 * @returns {string|null}
 */
function resolveMobile(order) {
    var phone = null;

    try {
        var billingAddress = order.getBillingAddress();
        phone = billingAddress && billingAddress.getPhone();
    } catch (e) {
        phone = null;
    }

    return isPlausiblePhone(phone) ? phone : null;
}

/**
 * Counts the order's non-option product line items - the number a FULL
 * reversal's lineItems[] array must exactly match. -1 on any failure to
 * read the collection at all, which can never equal a real built-item
 * count (>= 0) and therefore always trips the mismatch guard below rather
 * than risking a silent pass.
 * @param {dw.order.Order} order
 * @returns {number}
 */
function countNonOptionProductLineItems(order) {
    try {
        var count = 0;
        var it = order.getAllProductLineItems().iterator();
        while (it.hasNext()) {
            if (!lineItemPayload.isOptionLineItem(it.next())) {
                count++;
            }
        }
        return count;
    } catch (e) {
        return -1;
    }
}

/**
 * Builds the lineItems[] array for a FULL reversal: every product line item
 * at full quantity, produced by calling the existing, UNMODIFIED
 * lineItem.build(order) - the same builder order tracking uses
 * (orderPayload.js:331). See this file's module comment / section 4.2 for
 * why replaying the tracked shape, rather than a refund-specific mapping, is
 * the deliberate choice.
 *
 * Compares the built count against the order's own non-option product line
 * item count before trusting the result (edge case table, "one line item
 * throws while building"): lineItem.build() silently SKIPS any single item
 * that throws while building rather than aborting (H19, correct for order
 * tracking - one missing item there is a smaller total, not a false
 * success). On a REFUND that same behaviour would under-reverse and report
 * success anyway, so here it is refused instead: a caught build error is
 * turned into a hard throw naming line_items_incomplete, which
 * refundDelivery.js's own catch routes to MANUAL_REVIEW.
 *
 * A ZERO-item order (gift-certificate-only) is not an error: with no
 * products there can be no product/category/collection campaign points to
 * miss, so a cashback-only rollback is CORRECT here, not a gap - logged at
 * info so the log still explains itself.
 *
 * @param {dw.order.Order} order
 * @returns {Object[]}
 */
function buildFullLineItems(order) {
    var items = lineItemPayload.build(order);
    var expected = countNonOptionProductLineItems(order);

    if (items.length !== expected) {
        throw new Error('Gameball refund line item build incomplete for order ' + order.getOrderNo()
            + ' (line_items_incomplete): built ' + items.length + ' of ' + expected
            + ' non-option product line items - refusing rather than under-reversing campaign/collection points');
    }

    if (!items.length) {
        Logger.info('Gameball refund for order {0} has no product line items - Gameball will perform a cashback-only rollback, which is correct here', order.getOrderNo());
    }

    return items;
}

/**
 * Builds the lineItems[] array for a PARTIAL refund whose caller supplied
 * specific line items (entry.lineItems, already validated by
 * gameballRefundApi.submitRefund against the built order to resolve). Every
 * built item is indexed by extra.sfccUUID (lineItem.js:114-118), and only
 * the caller-named UUIDs are kept, with quantity overridden to the caller's
 * refunded quantity - price/taxes/discount are per-unit figures already and
 * stay correct unchanged.
 *
 * Guards independently (H22) rather than trusting the caller's earlier
 * resolvability check: an unresolvable UUID here throws INVALID_LINE_ITEM
 * rather than silently sending fewer items than requested, which would
 * under-reverse with no error.
 *
 * @param {dw.order.Order} order
 * @param {{productLineItemUUID: string, quantity: number}[]} requested
 * @returns {Object[]}
 */
function buildPartialLineItems(order, requested) {
    var built = lineItemPayload.build(order);
    var byUUID = {};
    var i;

    for (i = 0; i < built.length; i++) {
        var uuid = built[i].extra && built[i].extra.sfccUUID;
        if (uuid) {
            byUUID[uuid] = built[i];
        }
    }

    var selected = [];
    for (i = 0; i < requested.length; i++) {
        var want = requested[i];
        var match = want && want.productLineItemUUID ? byUUID[want.productLineItemUUID] : null;

        if (!match) {
            throw new Error('Gameball refund line item ' + (want && want.productLineItemUUID)
                + ' does not resolve to a line item on order ' + order.getOrderNo() + ' (INVALID_LINE_ITEM)');
        }

        var copy = {};
        var key;
        for (key in match) {
            if (Object.prototype.hasOwnProperty.call(match, key)) {
                copy[key] = match[key];
            }
        }
        copy.quantity = want.quantity;
        selected.push(copy);
    }

    return selected;
}

/**
 * Builds the request body for POST integrations/transactions/refund from an
 * order and one recorded ledger entry.
 *
 * Every identity-bearing field is REPLAYED, never re-derived: customerId and
 * reverseTransactionId come off order.custom exactly as order tracking wrote
 * them, and refundTransactionId/transactionTime come off the entry exactly
 * as refundStateStore.js minted them. Re-deriving any of the four is how a
 * reversal ends up pointing at a transaction Gameball does not have (9005)
 * or at an id a different refund already used (9004 misread as success).
 *
 * orderSyncGate-equivalent guarding: refundGate.evaluate already guarantees
 * a resolvable gbCustomerId/gbGameballOrderId before this is ever called
 * (via refundDelivery.js), but this function guards independently anyway
 * (H22) rather than relying on caller discipline - a future caller invoking
 * build() directly would otherwise silently send a malformed payload.
 *
 * @param {dw.order.Order} order - the order being reversed; must already be TRACKED
 * @param {Object} entry - one gbRefundLedger entry, see refundStateStore.js
 * @param {string} entry.refundTransactionId
 * @param {string} entry.transactionTime - ISO-8601 UTC
 * @param {boolean} entry.full - true means a full reversal; refundAmount is
 *   omitted and every product line item is replayed at full quantity
 * @param {number|null} entry.refundAmount - null on a full reversal
 * @param {Object[]|null} entry.lineItems - caller-selected partial items, or
 *   null (full reversal replays everything; a partial with no caller
 *   selection sends no lineItems key at all)
 * @returns {Object} the request body expected by Gameball's refund endpoint
 * @throws {Error} when gbCustomerId or gbGameballOrderId is missing, or when
 *   the lineItems build cannot be trusted (line_items_incomplete /
 *   INVALID_LINE_ITEM) - the caller (refundDelivery.js) catches this and
 *   settles the entry MANUAL_REVIEW rather than sending a payload that would
 *   silently under-reverse
 */
function build(order, entry) {
    var customerId = order.custom.gbCustomerId;
    var reverseTransactionId = order.custom.gbGameballOrderId;

    if (!customerId || !reverseTransactionId) {
        throw new Error('Gameball refund payload requires a TRACKED order with gbCustomerId and gbGameballOrderId (order '
            + (order && order.getOrderNo ? order.getOrderNo() : 'unknown') + ')');
    }

    var payload = {
        customerId: customerId,
        refundTransactionId: entry.refundTransactionId,
        // Case-sensitive, read verbatim - NEVER trim/upper/lower-case this
        // value and NEVER derive it from order.getOrderNo() (section 4.1). A
        // casing drift here yields 9005 Reversed Transaction Not Found,
        // which is a hard 404-class failure, not a silent no-op: the
        // reversal simply never happens.
        reverseTransactionId: reverseTransactionId,
        transactionTime: entry.transactionTime,
        merchant: {
            uniqueId: Site.getCurrent().getID(),
            name: Site.getCurrent().getName()
        }
    };

    var email = order.getCustomerEmail();
    if (email) {
        payload.email = email;
    }

    var mobile = resolveMobile(order);
    if (mobile) {
        payload.mobile = mobile;
    }

    // Omitting refundAmount is how "cancel this order" is expressed -
    // Gameball has no cancel endpoint (section 4.1). Never send null, never
    // send 0, never send the key with an undefined value (H31). The
    // typeof/!== 0 guard (rather than a plain truthy/falsy check on
    // entry.refundAmount, which would ALSO drop a legitimate NaN) excludes
    // exactly the "bad value" shapes H31 names: gameballRefundApi.js's
    // computeRefundAmount is the primary guard against a computed amount of
    // exactly 0 ever reaching an entry at all (it rejects before the ledger
    // entry is allocated), but this check stands independently rather than
    // trusting that caller discipline (H22) - a future caller building a
    // payload from a hand-constructed entry must not be able to put a literal
    // 0 on the wire either.
    if (typeof entry.refundAmount === 'number' && entry.refundAmount !== 0) {
        payload.refundAmount = entry.refundAmount;
    }

    if (entry.full) {
        var lineItems = buildFullLineItems(order);
        if (lineItems.length) {
            payload.lineItems = lineItems;
        }
    } else if (entry.lineItems && entry.lineItems.length) {
        payload.lineItems = buildPartialLineItems(order, entry.lineItems);
    } else {
        // A partial with no caller-supplied line items (a bare monetary
        // partial, or a SHIPPING/TAX/ADJUSTMENT kind where no product was
        // returned) - Gameball performs a cashback-only rollback, which is
        // the CORRECT semantic for those three kinds and a documented
        // limitation for a bare monetary RETURN/CANCELLATION partial (see
        // docs/refunds-integration-guide.md). Logged either way so the log
        // explains itself, matching the zero-line-item full-reversal case
        // above.
        Logger.info('Gameball refund {0} for order {1} carries no lineItems - Gameball will perform a cashback-only rollback (campaign/collection points are not adjusted)',
            entry.refundTransactionId, order.getOrderNo());
    }

    return payload;
}

module.exports = {
    build: build
};
