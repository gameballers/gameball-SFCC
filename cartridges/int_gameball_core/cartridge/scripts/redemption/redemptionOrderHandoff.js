'use strict';

var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');

/**
 * Finds the order-level PriceAdjustment item 08 created, by its own custom
 * attribute rather than redemptionStateStore.js's promotion-id constant -
 * this module has no other dependency on that file, and matching on the
 * attribute that actually matters keeps the two independent.
 * @param {dw.order.Order} order
 * @returns {dw.order.PriceAdjustment|null}
 */
function findAdjustment(order) {
    try {
        var adjustments = order.getPriceAdjustments();
        if (!adjustments) {
            return null;
        }

        var it = adjustments.iterator();
        while (it.hasNext()) {
            var adjustment = it.next();
            if (adjustment.custom && adjustment.custom.gbHoldReference) {
                return adjustment;
            }
        }
    } catch (e) {
        return null;
    }

    return null;
}

/**
 * Confirms (or repairs) that a just-placed order carrying a Pay with Points
 * redemption has the values orderPayload.js's resolveRedemption() needs,
 * called from CheckoutServices-PlaceOrder's route:BeforeComplete append -
 * BEFORE Order-Confirm's order-tracking call ever runs.
 *
 * Primary path: SFCC copies Basket PriceAdjustments, including their custom
 * attributes, onto the Order automatically at order creation - this is this
 * feature's central assumption (UNVERIFIED against a live instance; confirm
 * on a sandbox before go-live, alongside the master plan's own S1-S10
 * spikes). When the adjustment is found, this only MIRRORS its values onto
 * Order.custom.gbHoldReference/gbRedeemedPoints for Business Manager
 * visibility - orderPayload.js reads the PriceAdjustment directly, not
 * these fields.
 *
 * Fallback path: the automatic copy did not happen (or this order reached
 * PlaceOrder with no PriceAdjustment for some other reason). The
 * session-stash CheckoutServices-SubmitPayment's append writes is the only
 * remaining source. Self-healing either way this assumption resolves:
 * orderPayload.js's resolveRedemption() falls back to
 * Order.custom.gbHoldReference when no PriceAdjustment carries one, which is
 * exactly the field this fallback path writes.
 *
 * Never throws (H17) - called directly in front of the single highest-value
 * page in the funnel.
 *
 * @param {dw.order.Order} order
 * @param {{holdReference: (string|undefined), holdPoints: (number|string|undefined)}} sessionFallback
 * @returns {void}
 */
function confirmOrRepair(order, sessionFallback) {
    try {
        var adjustment = findAdjustment(order);

        if (adjustment && adjustment.custom.gbHoldReference) {
            Transaction.wrap(function () {
                order.custom.gbHoldReference = adjustment.custom.gbHoldReference;
                order.custom.gbRedeemedPoints = adjustment.custom.gbPointsRedeemed || 0;
            });
            return;
        }

        var stashedRef = sessionFallback && sessionFallback.holdReference;
        if (stashedRef) {
            Transaction.wrap(function () {
                order.custom.gbHoldReference = stashedRef;
                order.custom.gbRedeemedPoints = Number(sessionFallback.holdPoints) || 0;
            });
        }
    } catch (e) {
        Logger.error('redemptionOrderHandoff~confirmOrRepair failed for order {0}: {1}',
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
    }
}

module.exports = {
    confirmOrRepair: confirmOrRepair
};
