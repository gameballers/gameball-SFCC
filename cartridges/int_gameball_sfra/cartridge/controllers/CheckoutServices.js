'use strict';

var server = require('server');
server.extend(module.superModule);

var OrderMgr = require('dw/order/OrderMgr');
var BasketMgr = require('dw/order/BasketMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.redemption');
var redemptionReconcile = require('*/cartridge/scripts/redemption/redemptionReconcile');
var redemptionStateStore = require('*/cartridge/scripts/redemption/redemptionStateStore');
var redemptionOrderHandoff = require('*/cartridge/scripts/redemption/redemptionOrderHandoff');

/**
 * Reconciles any live Pay with Points hold against the basket after shipping
 * is submitted - the checkout-flow half of the same self-healing check
 * Cart.js appends onto every basket-mutating cart route (see
 * redemptionReconcile.js). A shipping method change can move the basket's
 * eligible total, which is exactly what this catches before the shopper
 * reaches payment.
 *
 * @name Base/CheckoutServices-SubmitShipping
 * @function
 * @memberof CheckoutServices
 */
server.append('SubmitShipping', function (req, res, next) {
    try {
        var basket = BasketMgr.getCurrentBasket();
        if (basket) {
            redemptionReconcile.reconcileBasketHold(basket);
        }
    } catch (e) {
        Logger.error('Gameball redemption reconciliation did not run on CheckoutServices-SubmitShipping: {0}', e && e.message);
    }

    next();
});

/**
 * Reconciles any live hold, then - if it is still live - stashes its
 * reference in session as a fallback for PlaceOrder's own hold-to-order
 * handoff (redemptionOrderHandoff.confirmOrRepair). Two small strings, well
 * under the 2,000-character api.session.maxStringLength ceiling. Exists
 * purely in case the Basket-to-Order PriceAdjustment custom-attribute copy
 * this feature's primary handoff path depends on does not happen on this
 * instance - see redemptionOrderHandoff.js's own module comment.
 *
 * This is also the last checkout step before the shopper clicks the final
 * "Place Order" button in SFRA's standard three-step checkout, so
 * reconciling here closes the gap to "the last few seconds of checkout" -
 * comfortably inside any realistic Gameball dashboard hold timeout. The
 * residual race (a hold expiring in the seconds between this and
 * PlaceOrder) is accepted and handled by the order-tracking failure path,
 * never by adding a synchronous liveness check inside PlaceOrder itself.
 *
 * @name Base/CheckoutServices-SubmitPayment
 * @function
 * @memberof CheckoutServices
 */
server.append('SubmitPayment', function (req, res, next) {
    try {
        var basket = BasketMgr.getCurrentBasket();
        if (basket) {
            redemptionReconcile.reconcileBasketHold(basket);

            var currentHold = redemptionStateStore.readHold(basket);
            if (currentHold) {
                session.privacy.gameballHoldReference = currentHold.holdReference;
                session.privacy.gameballHoldPoints = currentHold.holdPointsRedeemed;
            }
        }
    } catch (e) {
        Logger.error('Gameball redemption reconciliation did not run on CheckoutServices-SubmitPayment: {0}', e && e.message);
    }

    next();
});

/**
 * Confirms (or repairs) the placed order's redemption hold reference before
 * Order-Confirm's order-tracking call ever runs, then clears the session
 * stash regardless of outcome.
 *
 * Work sits in route:BeforeComplete (H45) because PlaceOrder redirects to
 * the confirmation page, and whether a redirecting route fires
 * route:Complete at all is UNVERIFIED - the same reasoning Order.js's
 * CreateAccount append already documents for the same reason.
 *
 * The whole listener is caught and only logged (H17): this route sits
 * directly in front of the single highest-value page in the funnel, and a
 * Gameball failure here must never be able to block order placement.
 *
 * @name Base/CheckoutServices-PlaceOrder
 * @function
 * @memberof CheckoutServices
 */
server.append('PlaceOrder', function (req, res, next) {
    this.on('route:BeforeComplete', function (req, res) {
        try {
            var viewData = res.getViewData();
            var orderNumber = viewData && viewData.orderID;

            if (orderNumber) {
                var order = OrderMgr.getOrder(orderNumber);
                if (order) {
                    redemptionOrderHandoff.confirmOrRepair(order, {
                        holdReference: session.privacy.gameballHoldReference,
                        holdPoints: session.privacy.gameballHoldPoints
                    });
                }
            }
        } catch (e) {
            Logger.error('Gameball redemption order handoff did not run: {0}', e && e.message);
        } finally {
            session.privacy.gameballHoldReference = null;
            session.privacy.gameballHoldPoints = null;
        }
    });

    next();
});

module.exports = server.exports();
