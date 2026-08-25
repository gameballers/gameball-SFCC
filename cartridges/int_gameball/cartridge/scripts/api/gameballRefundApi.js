'use strict';

/**
 * Gameball Refunds integration - PLACEHOLDER, not implemented.
 *
 * TODO (build-plan section 7.8): sync refunds to Gameball's refund endpoint:
 * POST /api/v4.0/integrations/transactions/refund
 * Required body fields: customerId, refundTransactionId,
 * reverseTransactionId (= original orderId), transactionTime.
 * Optional: refundAmount, lineItems.
 *
 * CRITICAL - DO NOT register a dw.order.payment.refund hook for this.
 * That hook belongs to the merchant's real payment service provider; hooking
 * into it here would shadow/interfere with real refund processing. Refund
 * detection must eventually be a polling/scheduled Job that snapshot-diffs
 * orders (e.g. via dw.order.OrderMgr.processOrders), never an event hook.
 * That job infrastructure is out of scope for this iteration and is deferred.
 *
 * Not wired into hooks.json, any job step, or any controller. Inert placeholder.
 */

/**
 * @param {Object} refundPayload - see models/payload/refundPayload.js
 */
// eslint-disable-next-line no-unused-vars
function sendRefund(refundPayload) {
    // Intentionally not implemented - see build-plan section 7.8.
}

module.exports = {
    sendRefund: sendRefund
};
