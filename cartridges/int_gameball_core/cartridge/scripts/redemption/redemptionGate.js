'use strict';

var Site = require('dw/system/Site');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
var gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');

/**
 * @returns {boolean} true once an admin has switched the feature on AND the
 * Gameball credential is configured. Mirrors orderSyncGate.isGameballEnabled()
 * / refundGate.isGameballEnabled() (H37) - duplicated rather than imported,
 * same reasoning as those two: three lines, and this module has zero other
 * dependency on either file.
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * @returns {boolean} true when the redemption feature's own master switch is
 * on. Deliberately separate from isGameballEnabled() (H38's "should we ever"
 * split, applied here exactly as refundGate.js applies it to its own
 * narrower flag): order tracking and the widget can stay on while redemption
 * is off.
 */
function isRedemptionEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnableRedemption');
}

/**
 * Decides whether a hold should ever be attempted right now - "should we
 * ever do this", never "have we already done this" (that split lives in
 * redemptionStateStore.js, H38).
 *
 * Deliberately narrower than order tracking's identity ladder
 * (gameballIdentity.getOrderCustomerId): a hold authorises spending an
 * EXISTING points balance, and only a real registered customerNo
 * (gameballIdentity.getRegisteredCustomerId) has one to spend against. A
 * login-matched guest order's identity is resolved from the ORDER after the
 * fact and has no live, interactive session to authorise a spend against -
 * excluded here even though order tracking accepts it. This is the master
 * plan's own stated Tier-3 rationale for choosing a server-authorised hold
 * over a bearer coupon code ("the spend is authorised server-side against
 * req.currentCustomer"), applied literally.
 *
 * @param {dw.order.Basket} basket
 * @param {Object} currentCustomer - SFRA req.currentCustomer
 * @returns {{shouldHold: boolean, reason: string, customerId: (string|undefined)}}
 */
function evaluate(basket, currentCustomer) {
    if (!isGameballEnabled()) {
        return { shouldHold: false, reason: 'gameball_disabled' };
    }

    if (!isRedemptionEnabled()) {
        return { shouldHold: false, reason: 'redemption_disabled' };
    }

    if (!basket) {
        return { shouldHold: false, reason: 'no_basket' };
    }

    try {
        if (basket.getProductLineItems().isEmpty()) {
            return { shouldHold: false, reason: 'empty_basket' };
        }
    } catch (e) {
        return { shouldHold: false, reason: 'basket_unreadable' };
    }

    if (basket.custom.gbHoldReference) {
        // A hold is already live on this basket - the shopper must Remove
        // (or the reconciliation path must release) before applying a new
        // one. Never silently replaces a hold, which would strand the old
        // one at Gameball with nothing left on the basket pointing at it.
        return { shouldHold: false, reason: 'hold_already_live' };
    }

    // CRITICAL: raw.authenticated === true is the whole authorisation check,
    // exactly as controllers/Gameball.js's Widget route requires for
    // exposing profile data. raw.profile can be populated for a
    // remembered-but-not-authenticated session; accepting that here would
    // let a "remember me" cookie spend a real shopper's points.
    var raw = currentCustomer && currentCustomer.raw;
    if (!raw || raw.authenticated !== true) {
        return { shouldHold: false, reason: 'not_authenticated' };
    }

    var customerId = gameballIdentity.getRegisteredCustomerId(raw.profile);
    if (!customerId) {
        return { shouldHold: false, reason: 'no_customer_id' };
    }

    return { shouldHold: true, reason: '', customerId: customerId };
}

module.exports = {
    evaluate: evaluate
};
