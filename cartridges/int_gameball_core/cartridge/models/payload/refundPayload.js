'use strict';

/**
 * Gameball Refunds payload builder - PLACEHOLDER, not implemented.
 *
 * TODO (build-plan section 7.8): build the request body for
 * POST /api/v4.0/integrations/transactions/refund
 * Required: customerId, refundTransactionId, reverseTransactionId
 * (= original orderId), transactionTime. Optional: refundAmount, lineItems.
 *
 * CRITICAL: refund DETECTION must never be wired via a dw.order.payment.refund
 * hook - see gameballRefundApi.js for why. This module only builds the payload
 * once a refund has already been detected by a future polling job.
 *
 * Not wired into hooks.json, any job step, or any controller. Inert placeholder.
 */

/**
 * @param {Object} refundContext - shape TBD once the detection job is designed
 * @returns {Object}
 */
// eslint-disable-next-line no-unused-vars
function build(refundContext) {
    // Intentionally not implemented - see build-plan section 7.8.
}

module.exports = {
    build: build
};
