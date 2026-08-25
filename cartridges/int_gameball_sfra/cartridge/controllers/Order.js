'use strict';

var server = require('server');
server.extend(module.superModule);

var OrderMgr = require('dw/order/OrderMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_order_confirm');
var gameballOrderApi = require('*/cartridge/scripts/api/gameballOrderApi');

/**
 * Fires the Gameball order-tracking sync right after the base Confirm route
 * renders its view data. This entire block must never throw and never delay
 * or break the confirmation page - a Gameball failure has to stay invisible
 * to the shopper, so it is only ever logged.
 */
server.append('Confirm', function (req, res, next) {
    try {
        var viewData = res.getViewData();
        var orderNumber = viewData && viewData.order && viewData.order.orderNumber;

        if (orderNumber) {
            // res.getViewData().order is a plain OrderModel (only exposes
            // storefront-facing fields) - the real dw.order.Order is needed
            // for the full API surface the payload builder relies on, so it
            // is re-fetched here rather than read off the view data.
            var order = OrderMgr.getOrder(orderNumber);
            if (order) {
                gameballOrderApi.sendOrder(order);
            }
        }
    } catch (e) {
        Logger.error('Gameball order-confirmation sync did not run: {0}', e && e.message);
    }

    next();
});

module.exports = server.exports();
