'use strict';

/**
 * Builds the request body for POST integrations/transactions/hold.
 *
 * Pure (H30): no req/session/customer dependence, no HTTP. customerId is
 * ALWAYS the caller's already-resolved, already-authorised value - this
 * module never derives identity itself. Unlike refundPayload.js/orderPayload.js,
 * there is no idempotency key to replay here: build-plan section 13.6's
 * documented hold fields have nothing resembling refundTransactionId, so
 * transactionTime is stamped fresh on every call rather than persisted and
 * replayed (see redemptionGate.js's own module comment for what that means
 * for retry safety).
 *
 * Only pointsToHold is ever sent of the three mutually-exclusive amount
 * fields (pointsToHold | amountToHold | ruleId) - points is the natural unit
 * for a slider denominated in the shopper's own balance. otp/ignoreOTP/hash
 * are POS/QR-only and are never sent from this storefront-authenticated-
 * session flow (plan's own explicit scope decision).
 *
 * @param {string} customerId - already-resolved via
 *   gameballIdentity.getRegisteredCustomerId - never a guest/derived id (see
 *   redemptionGate.js for why only rung 1 is ever accepted here)
 * @param {number} pointsToHold - positive integer, already range-validated
 *   by the caller against the shopper's own balance and the basket's caps
 * @param {Object} [options]
 * @param {string} [options.email] - omitted unless plausible (H31)
 * @returns {Object} the request body expected by Gameball's hold endpoint
 */
function buildHoldRequest(customerId, pointsToHold, options) {
    var opts = options || {};

    var payload = {
        customerId: customerId,
        transactionTime: new Date().toISOString(),
        pointsToHold: pointsToHold
    };

    if (opts.email) {
        payload.email = opts.email;
    }

    return payload;
}

module.exports = {
    buildHoldRequest: buildHoldRequest
};
