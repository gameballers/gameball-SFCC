'use strict';

/**
 * Gameball Orders payload builder - PLACEHOLDER, not implemented.
 *
 * TODO (build-plan section 5.9): build the request body for
 * POST /api/v4.0/integrations/orders from a dw.order.Order instance.
 * Required: customerId, orderId, orderDate, totalPaid.
 * Optional: totals, lineItems, redemption, extra.
 *
 * Not wired into hooks.json, any job step, or any controller. Inert placeholder.
 */

/**
 * @param {dw.order.Order} order
 * @returns {Object}
 */
// eslint-disable-next-line no-unused-vars
function build(order) {
    // Intentionally not implemented - see build-plan section 5.9.
}

module.exports = {
    build: build
};
