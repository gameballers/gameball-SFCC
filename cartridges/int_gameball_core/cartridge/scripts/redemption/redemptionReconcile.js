'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var gameballMoney = require('*/cartridge/scripts/util/gameballMoney');
var gameballRedemptionApi = require('*/cartridge/scripts/api/gameballRedemptionApi');
var redemptionStateStore = require('*/cartridge/scripts/redemption/redemptionStateStore');

var DEFAULT_MAX_PERCENT = 100;
var DEFAULT_MIN_ORDER_AMOUNT = 0;

/**
 * The basket's eligible total for redemption RIGHT NOW: gross price BEFORE
 * this module's own PriceAdjustment (subtracted back out if already
 * present, so the cap is computed against the same base every time -
 * re-applying it would otherwise shrink the eligible amount on every
 * recompute).
 * @param {dw.order.Basket} basket
 * @returns {number}
 */
function eligibleAmount(basket) {
    var gross = gameballMoney.toNumber(basket.getTotalGrossPrice());
    var existingHoldAmount = Number(basket.custom.gbHoldAmount) || 0;
    return gameballMoney.clampNonNegative(gross + existingHoldAmount);
}

/**
 * Site-preference-derived cap on how much of eligibleAmount a hold may
 * cover, per gameballRedemptionMaxPercentOfBasket /
 * gameballRedemptionMinOrderAmount. Shared by Cart-Redeem's own validation
 * (before a hold is created) and reconcileBasketHold below (checking whether
 * an EXISTING hold still fits) - exported so the SFRA controller layer
 * never re-derives this arithmetic (H6).
 * @param {dw.order.Basket} basket
 * @returns {{eligibleAmount: number, maxHoldAmount: number}}
 */
function computeCaps(basket) {
    var eligible = eligibleAmount(basket);

    var percent = parseInt(Site.getCurrent().getCustomPreferenceValue('gameballRedemptionMaxPercentOfBasket'), 10);
    if (isNaN(percent) || percent < 0) {
        percent = DEFAULT_MAX_PERCENT;
    }

    var minOrderAmount = Number(Site.getCurrent().getCustomPreferenceValue('gameballRedemptionMinOrderAmount'));
    if (isNaN(minOrderAmount) || minOrderAmount < 0) {
        minOrderAmount = DEFAULT_MIN_ORDER_AMOUNT;
    }

    var percentCap = eligible * (percent / 100);
    var floorCap = eligible - minOrderAmount;
    var maxHoldAmount = Math.min(percentCap, floorCap);

    return {
        eligibleAmount: eligible,
        maxHoldAmount: gameballMoney.clampNonNegative(Math.min(maxHoldAmount, eligible))
    };
}

/**
 * Self-healing, at-most-one-HTTP-call check of whether a live hold still
 * belongs on this basket. Called from every basket-mutating controller
 * route append (Cart-AddProduct, RemoveProductLineItem, UpdateQuantity,
 * AddCoupon, RemoveCouponLineItem, Show, CheckoutServices-SubmitShipping/
 * SubmitPayment).
 *
 * Deliberately NOT wired via a dw.order.calculate hook registration - that
 * hook is very likely single-implementation (the base SFRA cartridge's own
 * promotion/tax/shipping recalculation almost certainly depends on it), and
 * registering it here risks SHADOWING that recalculation entirely on any
 * instance where cartridge ordering puts this cartridge ahead of
 * app_storefront_base - a storefront-wide blast radius for a feature whose
 * actual requirement is only "notice when a hold no longer fits". The
 * per-route-append design achieves the same outcome with zero risk to
 * unrelated basket recalculation.
 *
 * Zero cost (no HTTP, no basket read past one custom attribute) when the
 * basket has never used this feature - by far the overwhelmingly common
 * case, and the whole reason this function is safe to append onto
 * high-traffic routes.
 *
 * @param {dw.order.Basket} basket
 * @returns {{changed: boolean, released: boolean}}
 */
function reconcileBasketHold(basket) {
    try {
        if (!basket || !basket.custom.gbHoldReference) {
            return { changed: false, released: false };
        }

        var caps = computeCaps(basket);
        var holdAmount = Number(basket.custom.gbHoldAmount) || 0;

        if (holdAmount > 0 && holdAmount <= caps.maxHoldAmount + 0.0001) {
            // Still fits. Self-heal the PriceAdjustment from the basket's
            // own attributes if promotion recalculation stripped it or
            // desynced its price - the basket's custom attributes, not the
            // PriceAdjustment, are always the source of truth this repair
            // trusts.
            redemptionStateStore.repairAdjustment(basket);
            return { changed: false, released: false };
        }

        // No longer fits - release. 9006 (hold already gone) classifies as
        // success under the REDEMPTION scope, so this call's failure path
        // only fires on a genuine Gameball-side problem, which is logged and
        // then still cleared locally (see the comment on clearHold itself
        // for why a stale local discount is worse than an orphaned remote
        // hold).
        var holdReference = basket.custom.gbHoldReference;
        var release = gameballRedemptionApi.releaseHold(holdReference);
        if (!release.ok) {
            Logger.error('redemptionReconcile~reconcileBasketHold: release failed for hold {0} on basket {1}: disposition={2} code={3} message={4}',
                holdReference, basket.getUUID(), release.disposition, release.code, release.message);
        }

        redemptionStateStore.clearHold(basket, 'basket_changed');

        return { changed: true, released: true };
    } catch (e) {
        // H17/H19: a reconciliation failure must never break the route it is
        // appended to.
        Logger.error('redemptionReconcile~reconcileBasketHold failed: {0}', e && e.message);
        return { changed: false, released: false };
    }
}

module.exports = {
    computeCaps: computeCaps,
    reconcileBasketHold: reconcileBasketHold
};
