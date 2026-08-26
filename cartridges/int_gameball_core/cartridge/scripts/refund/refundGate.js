'use strict';

var Site = require('dw/system/Site');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

// Re-declared rather than exported from orderPayload.js (which owns the
// twin at orderPayload.js:12) - a deliberate contention trade, not an
// oversight. Adding an export to orderPayload.js for one string would force
// this item to edit the single most contended payload file in the cartridge;
// arbitration section 7 V-10 records this exact duplication as a knowingly
// accepted follow-up, to be collapsed into the future
// scripts/utils/gameballConstants.js (build-plan section 9, not created in
// this train) alongside GUEST_PREFIX and the widget's platform/loader
// literals.
var GAMEBALL_POINTS_PAYMENT_METHOD = 'GAMEBALL_POINTS';

/**
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager. Byte-identical to
 * orderSyncGate.js's own isGameballEnabled() (H37) - duplicated rather than
 * imported for the same reason resolveAttemptIdentity is duplicated across
 * gameballOrderApi.js/retryFailedOrders.js: it is three lines, and this
 * module already has zero dependency on orderSyncGate.js's Order-status
 * machinery.
 * @returns {boolean}
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * @returns {boolean} true when the refund feature's own master switch is on.
 * Deliberately separate from isGameballEnabled() (H38's "should we ever" /
 * "have we already" split, applied here to a second, narrower feature flag):
 * order tracking can stay on while refunds are off.
 */
function isRefundsEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnableRefunds');
}

/**
 * True when the order carries a payment instrument whose method is the
 * Gameball-points tender. Gameball's behaviour on a PARTIAL refund of a
 * points+cash hybrid order is undefined (build-plan section 7.5) - a FULL
 * reversal is documented (cashback reversed, redeemed points returned) and
 * is not affected by this check.
 *
 * Fails CLOSED on any exception - the opposite of "not hybrid" - because this
 * is the sole guard against sending a PARTIAL refund for an order whose
 * payment-instrument composition could not actually be verified. Mirrors
 * gameballRefundApi.js's requestedLineItemsResolve, which chooses the same
 * conservative direction on its own build failure for the same reason: an
 * order.getPaymentInstruments()/getPaymentMethod() throw (a corrupted or
 * legacy instrument, a custom PSP cartridge's instrument subclass misbehaving)
 * means composition is UNKNOWN, not "confirmed non-hybrid" - returning false
 * here would let exactly the partial-refund-on-a-hybrid-order case guard 12
 * (hybrid_partial_undefined) exists to block through unverified.
 * @param {dw.order.Order} order
 * @returns {boolean}
 */
function hasGameballPointsInstrument(order) {
    try {
        var instruments = order.getPaymentInstruments();
        if (!instruments) {
            return false;
        }

        var it = instruments.iterator();
        while (it.hasNext()) {
            if (it.next().getPaymentMethod() === GAMEBALL_POINTS_PAYMENT_METHOD) {
                return true;
            }
        }
    } catch (e) {
        return true;
    }

    return false;
}

/**
 * Decides whether a refund should ever be sent for this order right now,
 * before any payload is built or any API call is made. Mirrors
 * orderSyncGate.evaluate in shape and JSDoc style (H38: this answers only
 * "should we ever do this" - "have we already done this" is
 * refundStateStore.js's ledger, and "what do we do about a refusal" is the
 * caller's, per skipState below).
 *
 * Checked in the fixed order build-plan section 5.4 specifies - each row is
 * a review-block if reordered, because several of them are deliberately
 * cheaper-first (no HTTP, no order read past a custom attribute) ahead of
 * the two that read gbTrackedTotalPaid/payment instruments.
 *
 * skipState is null on exactly two rows (gameball_disabled, refunds_disabled)
 * - a switched-off integration must never scribble MANUAL_REVIEW onto every
 * order it is asked about, which would then have to be cleaned up by hand
 * the moment a merchant switches the feature back on.
 *
 * reason 'order_not_tracked' is NOT a refusal in the usual sense even though
 * shouldSend is false for it: the caller (gameballRefundApi.submitRefund)
 * records a WAITING_FOR_ORDER entry rather than rejecting the call outright,
 * because a refund arriving before its order was tracked is a timing
 * problem, not a data problem - see refundDelivery.js and
 * docs/refunds-integration-guide.md.
 *
 * @param {dw.order.Order} order
 * @param {Object} spec - {full: boolean, refundAmount: (number|null)}
 * @returns {{shouldSend: boolean, skipState: (string|null), reason: string}}
 */
function evaluate(order, spec) {
    var refundSpec = spec || {};

    if (!order) {
        return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'no_order' };
    }

    if (!isGameballEnabled()) {
        return { shouldSend: false, skipState: null, reason: 'gameball_disabled' };
    }

    if (!isRefundsEnabled()) {
        return { shouldSend: false, skipState: null, reason: 'refunds_disabled' };
    }

    if (order.custom.gbTrackState !== 'TRACKED') {
        return { shouldSend: false, skipState: null, reason: 'order_not_tracked' };
    }

    if (!order.custom.gbGameballOrderId) {
        return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'no_gameball_order_id' };
    }

    if (!order.custom.gbCustomerId) {
        return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'no_customer_id' };
    }

    var trackedCurrency = order.custom.gbTrackedCurrency;
    if (trackedCurrency && order.getCurrencyCode() !== trackedCurrency) {
        // No currency field exists on any Gameball endpoint (section 4.4) -
        // a mismatch is never converted, only escalated. Orders tracked
        // before gbTrackedCurrency existed carry no value here and are not
        // blocked by this check.
        return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'currency_mismatch' };
    }

    if (order.custom.gbRefundState === 'FULL') {
        return { shouldSend: false, skipState: 'FULL', reason: 'already_fully_refunded' };
    }

    if (order.custom.gbRefundState === 'MANUAL_REVIEW') {
        return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'awaiting_manual_review' };
    }

    if (refundSpec.full !== true) {
        var trackedTotal = Number(order.custom.gbTrackedTotalPaid);
        if (!isFinite(trackedTotal) || trackedTotal <= 0) {
            // The ceiling is unknown, so no PARTIAL can be bounded. A FULL
            // reversal is still allowed elsewhere in this function: it omits
            // refundAmount entirely and needs no ceiling.
            return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'no_tracked_total' };
        }

        var refundedSoFar = Number(order.custom.gbRefundedAmount) || 0;
        var amount = typeof refundSpec.refundAmount === 'number' ? refundSpec.refundAmount : 0;
        if (refundedSoFar + amount > trackedTotal) {
            // Never clamped, never sent - build-plan section 7.5 is
            // explicit. Clamping would silently under-reverse and hide a
            // real accounting discrepancy behind a green response.
            return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'exceeds_tracked_total' };
        }

        if (hasGameballPointsInstrument(order)) {
            return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'hybrid_partial_undefined' };
        }
    } else if (order.custom.gbRefundState === 'PARTIAL') {
        // Whether Gameball would double-reverse the already-refunded
        // portion on a full reversal issued after a partial is undocumented
        // (build-plan section 7.9 Q3) - escalate, never guess.
        return { shouldSend: false, skipState: 'MANUAL_REVIEW', reason: 'full_after_partial' };
    }

    return { shouldSend: true, skipState: null, reason: '' };
}

module.exports = {
    evaluate: evaluate
};
