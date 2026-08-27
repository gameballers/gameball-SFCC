'use strict';

var server = require('server');
server.extend(module.superModule);

var BasketMgr = require('dw/order/BasketMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.redemption');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var redemptionGate = require('*/cartridge/scripts/redemption/redemptionGate');
var redemptionReconcile = require('*/cartridge/scripts/redemption/redemptionReconcile');
var redemptionStateStore = require('*/cartridge/scripts/redemption/redemptionStateStore');

/**
 * Applies a Pay with Points redemption to the current basket: validates the
 * requested points amount server-side (never trusts a client-supplied cap -
 * gameballRedeem.js's own slider max is a display estimate only), creates a
 * Gameball hold, and applies it as an order-level PriceAdjustment.
 *
 * Every rejection reason (gate refusal, invalid amount, insufficient
 * balance, exceeds cap, Gameball failure) returns the SAME shape,
 * { success: false, error: <reason> } - gameballRedeem.js maps reason codes
 * to shopper-facing copy; nothing here ever throws a raw Gameball error or
 * exception message to the browser.
 *
 * This cartridge's first CSRF-protected route - server.middleware.https +
 * csrfProtection.validateAjaxRequest mirrors the standard SFRA
 * Cart-AddCoupon shape.
 *
 * @name Base/Cart-Redeem
 * @function
 * @memberof Cart
 * @param {middleware} - server.middleware.https
 * @param {middleware} - csrfProtection.validateAjaxRequest
 * @param {category} - sensitive (spends a real points balance)
 * @param {renders} - json
 * @param {serverfunction} - post
 */
server.post('Redeem', server.middleware.https, csrfProtection.validateAjaxRequest, function (req, res, next) {
    try {
        var basket = BasketMgr.getCurrentBasket();
        var gate = redemptionGate.evaluate(basket, req.currentCustomer);

        if (!gate.shouldHold) {
            res.json({ success: false, error: gate.reason });
            return next();
        }

        var requestedPoints = parseInt(req.form.points, 10);
        if (!isFinite(requestedPoints) || requestedPoints <= 0) {
            res.json({ success: false, error: 'invalid_amount' });
            return next();
        }

        // Late require - see Gameball.js's own resolveRedeemState comment
        // for why gameballRedemptionApi (a LocalServiceRegistry side effect,
        // transitively via gameballService) is never required at this
        // file's module top: this controller also carries the
        // basket-mutating-route appends below, which run on far
        // higher-traffic routes (AddProduct, Show, ...) than this one.
        var gameballRedemptionApi = require('*/cartridge/scripts/api/gameballRedemptionApi');

        // Re-fetched fresh rather than trusting any client-supplied balance
        // figure - the whole point of a server-authorised hold (build-plan
        // section 8.4's Tier-3 rationale).
        var balance = gameballRedemptionApi.getBalance(gate.customerId);
        if (!balance.ok || !balance.body) {
            res.json({ success: false, error: 'balance_unavailable' });
            return next();
        }

        var availablePointsBalance = Number(balance.body.availablePointsBalance) || 0;
        if (requestedPoints > availablePointsBalance) {
            res.json({ success: false, error: 'insufficient_points' });
            return next();
        }

        var caps = redemptionReconcile.computeCaps(basket);
        var availablePointsValue = Number(balance.body.availablePointsValue) || 0;
        var pointsPerCurrencyUnit = availablePointsValue > 0 ? (availablePointsBalance / availablePointsValue) : 0;
        var maxRedeemablePoints = pointsPerCurrencyUnit > 0 ? Math.floor(caps.maxHoldAmount * pointsPerCurrencyUnit) : 0;

        if (requestedPoints > maxRedeemablePoints) {
            res.json({ success: false, error: 'amount_too_large' });
            return next();
        }

        var hold = gameballRedemptionApi.createHold(gate.customerId, requestedPoints, {});

        if (!hold.ok || !hold.body) {
            if (hold.code === '9008') {
                // A normal declined-request outcome, not a system failure -
                // no error-level log (see gameballErrors.js's own comment on
                // this row).
                res.json({ success: false, error: 'insufficient_points' });
            } else {
                Logger.error('Gameball hold create failed for customer {0}: disposition={1} code={2} message={3}',
                    gate.customerId, hold.disposition, hold.code, hold.message);
                res.json({ success: false, error: 'try_again' });
            }
            return next();
        }

        var holdAmount = Number(hold.body.holdAmount) || 0;

        if (holdAmount > caps.maxHoldAmount + 0.0001) {
            // Gameball's own point-to-currency conversion rounded the
            // amount past what this request validated as safe - release
            // immediately rather than leave an over-cap hold live on the
            // basket. The one place this route makes two outbound calls
            // (still far under P5's 16-send storefront ceiling).
            var release = gameballRedemptionApi.releaseHold(hold.body.holdReference);
            if (!release.ok) {
                Logger.error('Gameball hold {0} exceeded the basket cap and its release also failed: disposition={1} code={2} message={3}',
                    hold.body.holdReference, release.disposition, release.code, release.message);
            }
            res.json({ success: false, error: 'amount_too_large' });
            return next();
        }

        redemptionStateStore.applyHold(basket, hold.body);

        res.json({ success: true, currentHold: redemptionStateStore.readHold(basket) });
        return next();
    } catch (e) {
        Logger.error('Cart-Redeem failed: {0}', e && e.message);
        res.json({ success: false, error: 'internal_error' });
        return next();
    }
});

/**
 * Removes any live Pay with Points redemption from the current basket:
 * releases the Gameball hold (idempotent - an already-gone hold, code 9006,
 * classifies as success under the REDEMPTION scope) and clears the local
 * PriceAdjustment/gbHold* attributes REGARDLESS of the Gameball outcome - a
 * discount left live on the SFCC basket after the shopper explicitly asked
 * to remove it is a worse, immediately-visible bug than an orphaned remote
 * hold, which Gameball's own dashboard timeout recovers on its own.
 *
 * Idempotent when no hold is live: returns success rather than an error, so
 * a double-click or a retried request never surfaces a spurious failure.
 *
 * @name Base/Cart-RedeemRemove
 * @function
 * @memberof Cart
 * @param {middleware} - server.middleware.https
 * @param {middleware} - csrfProtection.validateAjaxRequest
 * @param {category} - sensitive
 * @param {renders} - json
 * @param {serverfunction} - post
 */
server.post('RedeemRemove', server.middleware.https, csrfProtection.validateAjaxRequest, function (req, res, next) {
    try {
        var basket = BasketMgr.getCurrentBasket();
        var currentHold = basket ? redemptionStateStore.readHold(basket) : null;

        if (!currentHold) {
            res.json({ success: true });
            return next();
        }

        var gameballRedemptionApi = require('*/cartridge/scripts/api/gameballRedemptionApi');
        var release = gameballRedemptionApi.releaseHold(currentHold.holdReference);

        if (!release.ok) {
            Logger.error('Gameball hold release failed for hold {0}: disposition={1} code={2} message={3}',
                currentHold.holdReference, release.disposition, release.code, release.message);
        }

        redemptionStateStore.clearHold(basket, 'shopper_remove');

        res.json({ success: true });
        return next();
    } catch (e) {
        Logger.error('Cart-RedeemRemove failed: {0}', e && e.message);
        res.json({ success: false, error: 'internal_error' });
        return next();
    }
});

// Every base Cart route that can change what the basket is eligible to
// redeem gets the same self-healing check appended - one shared block
// rather than six copy-pasted ones (identical but for the route name) that
// could drift apart over time. redemptionReconcile.js owns the actual
// logic and is a no-op (zero HTTP calls) for any basket that has never used
// this feature; this constant is only the list of routes that can
// invalidate a live hold.
var BASKET_MUTATING_ROUTES = ['AddProduct', 'RemoveProductLineItem', 'UpdateQuantity', 'AddCoupon', 'RemoveCouponLineItem', 'Show'];

BASKET_MUTATING_ROUTES.forEach(function (routeName) {
    server.append(routeName, function (req, res, next) {
        try {
            var basket = BasketMgr.getCurrentBasket();
            if (basket) {
                redemptionReconcile.reconcileBasketHold(basket);
            }
        } catch (e) {
            // H17: reconciliation must never break the cart route it rides
            // on top of.
            Logger.error('Gameball redemption reconciliation did not run on Cart-{0}: {1}', routeName, e && e.message);
        }

        next();
    });
});

module.exports = server.exports();
