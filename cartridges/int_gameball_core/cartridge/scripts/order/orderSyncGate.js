'use strict';

var Site = require('dw/system/Site');
var Order = require('dw/order/Order');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
var gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');

/**
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * @returns {boolean} true when guest order tracking has been switched on
 * for this site. Deliberately a separate flag from isGameballEnabled(): the
 * integration being on says nothing about whether profile-less orders
 * should ever be sent. Off by default, so installing this feature changes
 * nothing until a merchant opts in.
 */
function isGuestTrackingEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballTrackGuestOrders');
}

/**
 * @param {dw.order.Order} order
 * @returns {string} order.getOriginalOrderNo(), or '' if unavailable/absent.
 * Guarded because getOriginalOrderNo isn't guaranteed to exist on every
 * environment/mock this code might run against.
 */
function getOriginalOrderNo(order) {
    try {
        if (typeof order.getOriginalOrderNo === 'function') {
            return order.getOriginalOrderNo() || '';
        }
    } catch (e) {
        return '';
    }

    return '';
}

/**
 * Decides whether a given order should ever be synced to Gameball, before
 * any payload is built or any API call is made. This only covers the
 * "should we ever track this order" rules:
 *   1. integration enabled + Service Credential configured
 *   2. the order is not a replacement order (tracking a replacement without
 *      also reversing the original's points award would double-award the
 *      same purchase - reversal isn't built yet, so skip rather than risk it)
 *   3. the order isn't in a terminal CANCELLED/FAILED status
 *   4. a registered customer placed the order, OR guest order tracking is
 *      switched on (gameballTrackGuestOrders) and the identity ladder in
 *      models/identity/gameballIdentity can resolve a customerId for it
 *
 * Replacement-order and terminal-status now run BEFORE identity resolution
 * (they used to run after the old unconditional guest check) - an order
 * that is going to be skipped for either reason should never pay for a
 * CustomerMgr lookup or a SHA-256 digest first.
 *
 * The separate gbTrackState === 'TRACKED' idempotency check ("have we
 * already tracked this specific order") intentionally lives in
 * gameballOrderApi.js instead - that one is about "already done", this one
 * is about "should never do".
 * @param {dw.order.Order} order - the placed SFCC order
 * @returns {{shouldTrack: boolean, skipState: (string|null), reason: string}}
 */
function evaluate(order) {
    if (!order) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'no_order' };
    }

    if (!isGameballEnabled()) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'gameball_disabled' };
    }

    var origOrderNo = getOriginalOrderNo(order);
    if (origOrderNo && origOrderNo !== order.getOrderNo()) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'replacement_order (' + origOrderNo + ')' };
    }

    var status = order.getStatus();
    if (status === Order.ORDER_STATUS_CANCELLED || status === Order.ORDER_STATUS_FAILED) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'terminal_status' };
    }

    var customer = order.getCustomer();
    var profile = customer && customer.getProfile();

    if (profile) {
        if (!profile.getCustomerNo()) {
            // A registered profile with no customer number (an imported or
            // legacy record) must never fall through to the guest branch
            // below - handing a registered shopper a gb_guest_* profile
            // would permanently split their balance across two Gameball
            // records.
            return { shouldTrack: false, skipState: 'SKIPPED', reason: 'profile_without_customer_no' };
        }
        return { shouldTrack: true, skipState: null, reason: '' };
    }

    // No profile - guest path. gameballTrackGuestOrders is the master
    // switch: with it off, no profile-less order is tracked, not even one
    // whose email would match a registered login further down the ladder.
    // Rejected alternative: letting the login-match rung run while this
    // flag is off - a merchant who has never enabled guest tracking would
    // suddenly see profile-less orders posting to Gameball.
    if (!isGuestTrackingEnabled()) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'guest_order' };
    }

    var identity = gameballIdentity.getOrderCustomerId(order);
    if (!identity.customerId) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: identity.reason || 'guest_no_identifier' };
    }

    return { shouldTrack: true, skipState: null, reason: '' };
}

module.exports = {
    evaluate: evaluate
};
