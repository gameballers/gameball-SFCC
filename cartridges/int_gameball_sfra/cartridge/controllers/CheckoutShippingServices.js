'use strict';

var server = require('server');
server.extend(module.superModule);

var BasketMgr = require('dw/order/BasketMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.redemption');
var redemptionReconcile = require('*/cartridge/scripts/redemption/redemptionReconcile');

/**
 * Reconciles any live Pay with Points hold against the basket after shipping
 * is submitted - the checkout-flow half of the same self-healing check
 * Cart.js appends onto every basket-mutating cart route (see
 * redemptionReconcile.js). A shipping method change can move the basket's
 * eligible total, which is exactly what this catches before the shopper
 * reaches payment.
 *
 * @name Base/CheckoutShippingServices-SubmitShipping
 * @function
 * @memberof CheckoutShippingServices
 */
server.append('SubmitShipping', function (req, res, next) {
    try {
        var basket = BasketMgr.getCurrentBasket();
        if (basket) {
            redemptionReconcile.reconcileBasketHold(basket);
        }
    } catch (e) {
        Logger.error('Gameball redemption reconciliation did not run on CheckoutShippingServices-SubmitShipping: {0}', e && e.message);
    }

    next();
});

module.exports = server.exports();
