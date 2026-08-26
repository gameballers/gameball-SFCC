'use strict';

var Site = require('dw/system/Site');
var Order = require('dw/order/Order');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

/**
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
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
 *   2. a registered customer placed the order (guest orders are skipped -
 *      no guest identity-minting/hashing feature exists in this iteration)
 *   3. the order is not a replacement order (tracking a replacement without
 *      also reversing the original's points award would double-award the
 *      same purchase - reversal isn't built yet, so skip rather than risk it)
 *   4. the order isn't in a terminal CANCELLED/FAILED status
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

    var customer = order.getCustomer();
    var profile = customer && customer.getProfile();
    if (!profile) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'guest_order' };
    }

    var origOrderNo = getOriginalOrderNo(order);
    if (origOrderNo && origOrderNo !== order.getOrderNo()) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'replacement_order (' + origOrderNo + ')' };
    }

    var status = order.getStatus();
    if (status === Order.ORDER_STATUS_CANCELLED || status === Order.ORDER_STATUS_FAILED) {
        return { shouldTrack: false, skipState: 'SKIPPED', reason: 'terminal_status' };
    }

    return { shouldTrack: true, skipState: null, reason: '' };
}

module.exports = {
    evaluate: evaluate
};
