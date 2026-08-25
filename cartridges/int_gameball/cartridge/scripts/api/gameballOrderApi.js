'use strict';

/**
 * Gameball Orders integration - PLACEHOLDER, not implemented.
 *
 * TODO (build-plan section 5.9): sync confirmed SFCC orders to Gameball's
 * orders upsert endpoint: POST /api/v4.0/integrations/orders
 * Required body fields: customerId, orderId, orderDate, totalPaid.
 * Optional: totals, lineItems, redemption, extra.
 *
 * IMPORTANT: no single SFCC hook/event reliably covers async payment capture
 * or OMS order-status transitions for this trigger. The build plan recommends
 * an outbound-queue + drain-job pattern (Custom Object queue + scheduled Job),
 * NOT a direct synchronous call from checkout. That infrastructure is out of
 * scope for this iteration and is deferred.
 *
 * Not wired into hooks.json, any job step, or any controller. Inert placeholder.
 */

/**
 * @param {Object} orderPayload - see models/payload/orderPayload.js
 */
// eslint-disable-next-line no-unused-vars
function sendOrder(orderPayload) {
    // Intentionally not implemented - see build-plan section 5.9.
}

module.exports = {
    sendOrder: sendOrder
};
