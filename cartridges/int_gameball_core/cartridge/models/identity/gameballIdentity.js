'use strict';

var Site = require('dw/system/Site');
var CustomerMgr = require('dw/customer/CustomerMgr');
var gameballHash = require('*/cartridge/scripts/util/gameballHash');

// Cannot collide with an SFCC customerNo (plan §4.11) - a customer number is
// always platform-generated, never starts with a merchant-invisible letter
// prefix like this one. Kept as a module constant rather than a preference:
// the plan names no preference for it, and a merchant-editable prefix would
// re-key every existing guest the moment it changed (H7).
var GUEST_PREFIX = 'gb_guest_';
// Gameball §13.3's hard limit on customerId.
var MAX_CUSTOMER_ID_LENGTH = 100;

var MODE_SKIP = 'SKIP';
var MODE_PER_ORDER = 'PER_ORDER';
var MODE_PER_EMAIL = 'PER_EMAIL';

var SOURCE_PROFILE = 'PROFILE';
var SOURCE_LOGIN_MATCH = 'LOGIN_MATCH';
var SOURCE_GUEST_PER_ORDER = 'GUEST_PER_ORDER';
var SOURCE_GUEST_PER_EMAIL = 'GUEST_PER_EMAIL';

var REASON_NO_ORDER = 'no_order';
var REASON_PROFILE_WITHOUT_CUSTOMER_NO = 'profile_without_customer_no';
var REASON_GUEST_ORDER_MODE_SKIP = 'guest_order_mode_skip';
var REASON_GUEST_NO_IDENTIFIER = 'guest_no_identifier';
var REASON_GUEST_ID_TOO_LONG = 'guest_id_too_long';

/**
 * @typedef {Object} GameballOrderIdentity
 * @property {string} customerId - the exact value to send as Gameball's
 *   customerId, or '' when no id could be derived (the caller must then
 *   skip the order rather than send an empty/placeholder value)
 * @property {boolean} guest - Gameball's `guest` flag: false on rungs 1
 *   (registered profile) and 2 (guest matched to an existing login), true
 *   on rung 3 (true guest)
 * @property {string} source - PROFILE | LOGIN_MATCH | GUEST_PER_ORDER |
 *   GUEST_PER_EMAIL, or '' when customerId is ''. Persisted verbatim to
 *   Order.custom.gbCustomerIdSource by gameballOrderApi.
 * @property {string} reason - '' on success; otherwise one of no_order |
 *   profile_without_customer_no | guest_order_mode_skip |
 *   guest_no_identifier | guest_id_too_long, consumed by orderSyncGate as
 *   the SKIPPED reason
 */

/**
 * gameballGuestOrderMode, trimmed and uppercased. Anything unrecognised,
 * empty or null becomes PER_ORDER, never SKIP - silently ceasing to track a
 * guest order is a worse failure than tracking it under the documented
 * default (plan §5.3).
 * @returns {string}
 */
function getGuestOrderMode() {
    var raw = Site.getCurrent().getCustomPreferenceValue('gameballGuestOrderMode');
    var mode = raw ? String(raw).trim().toUpperCase() : '';

    if (mode === MODE_SKIP || mode === MODE_PER_EMAIL) {
        return mode;
    }

    return MODE_PER_ORDER;
}

/**
 * @returns {string} Site.getCurrent().getID(), or '' on failure. Guarded
 * because a job-context caller (a future retry step) may run without a
 * declared site context - see the cross-item note in orderSyncGate.js.
 */
function getSiteId() {
    try {
        return Site.getCurrent().getID() || '';
    } catch (e) {
        return '';
    }
}

/**
 * Normalises an email for use ONLY as the PER_EMAIL hash input - never for
 * the `email` field actually sent to Gameball, which stays byte-verbatim
 * from order.getCustomerEmail() (plan §4.11 explicitly rejects
 * character-stripping normalisation such as Yotpo's
 * `[^0-9a-zA-Z\s_-]` regex, which would fuse `a+x@d` and `a+y@d` into one
 * identity).
 * Returns '' unless, after trim+lowercase, the value is non-empty, contains
 * an '@', and has at least one character on each side of the first '@'.
 * This is the guard that keeps sha256Hex from ever being asked to digest an
 * empty or unusable string - see buildGuestIdentity.
 * @param {string} rawEmail
 * @returns {string}
 */
function normaliseEmailForHash(rawEmail) {
    if (!rawEmail) {
        return '';
    }

    var normalised = String(rawEmail).trim().toLowerCase();
    var atIndex = normalised.indexOf('@');

    if (atIndex <= 0 || atIndex === normalised.length - 1) {
        return '';
    }

    return normalised;
}

/**
 * Resolves a guest order's email to an existing registered customer login,
 * guarded end-to-end (H18). CustomerMgr.getCustomerByLogin matches on the
 * customer's LOGIN, not necessarily the email address (plan §5.3) - on a
 * storefront where login != email this is a permanent silent no-op, which
 * is exactly why the caller sits behind the gameballLinkGuestOrdersByLogin
 * preference and why that preference's description spells the caveat out.
 * @param {string} email
 * @returns {dw.customer.Profile|null}
 */
function resolveProfileByLogin(email) {
    try {
        var matched = CustomerMgr.getCustomerByLogin(email);
        var matchedProfile = matched && matched.getProfile();
        return matchedProfile || null;
    } catch (e) {
        return null;
    }
}

/**
 * Rung 3 of the ladder: derives an identity for an order that has no
 * registered profile and did not resolve to one via a login match. Pure -
 * see getOrderCustomerId for why that matters.
 * @param {dw.order.Order} order
 * @returns {GameballOrderIdentity}
 */
function buildGuestIdentity(order) {
    var mode = getGuestOrderMode();

    if (mode === MODE_SKIP) {
        return { customerId: '', guest: true, source: '', reason: REASON_GUEST_ORDER_MODE_SKIP };
    }

    var customerId = '';
    var source = '';

    if (mode === MODE_PER_EMAIL) {
        var key = normaliseEmailForHash(order.getCustomerEmail());
        var siteId = getSiteId();

        // THE MANDATED HIGH-SEVERITY GUARD (spec 05 §5.2 rung 3c).
        // order.getCustomerEmail() is null for POS / isImported() /
        // OMS-created orders. Hashing an empty key or an empty siteId would
        // collapse every such order across the ENTIRE storefront into one
        // shared Gameball guest profile with one shared points balance -
        // unrecoverable in production, because Gameball has no re-key and
        // no un-merge API. Both inputs are checked BEFORE the digest call,
        // not after, so sha256Hex('') / sha256Hex('|' + siteId) /
        // sha256Hex(key + '|') can never be computed.
        if (key && siteId) {
            var digest = gameballHash.sha256Hex(key + '|' + siteId);
            if (digest) {
                customerId = GUEST_PREFIX + digest;
                source = SOURCE_GUEST_PER_EMAIL;
            }
        }
        // Missing key/siteId, or a failed digest: fall through to the
        // PER_ORDER derivation below rather than ever emit a bare
        // GUEST_PREFIX with nothing appended.
    }

    if (!customerId) {
        var orderNo = order.getOrderNo();
        if (!orderNo) {
            // Cannot happen on a placed order today; guarded because a
            // fabricated/mocked order from a future job caller would
            // otherwise mint the same bare GUEST_PREFIX for everyone.
            return { customerId: '', guest: true, source: '', reason: REASON_GUEST_NO_IDENTIFIER };
        }
        customerId = GUEST_PREFIX + orderNo;
        source = SOURCE_GUEST_PER_ORDER;
    }

    // Gameball §13.3 caps customerId at 100 chars. GUEST_PREFIX (9 chars) +
    // a 64-char hex digest is always 73, safely under the limit; GUEST_PREFIX
    // + an order number depends on the merchant's OrderNoSequence, and
    // sending a value Gameball might truncate would silently fuse two
    // guests onto one profile. Never truncate (plan §5.3) - skip instead.
    if (customerId.length > MAX_CUSTOMER_ID_LENGTH) {
        return { customerId: '', guest: true, source: '', reason: REASON_GUEST_ID_TOO_LONG };
    }

    return { customerId: customerId, guest: true, source: source, reason: '' };
}

/**
 * Raw dw.customer.Profile#customerNo, guarded (H18), with no prefix and no
 * case change - Skip: Identity collision safety is binding, so a
 * registered shopper's id is only ever read here, never minted, persisted
 * or altered. Exported so a later item (widget identity, customer sync)
 * converges on one accessor instead of re-reading customerNo in several
 * places.
 * @param {dw.customer.Profile} profile
 * @returns {string} '' when unavailable
 */
function getRegisteredCustomerId(profile) {
    try {
        return (profile && profile.getCustomerNo()) || '';
    } catch (e) {
        return '';
    }
}

/**
 * The identity ladder: resolves the Gameball customerId + guest flag for
 * ANY order - registered, guest-matched-to-a-login, or true guest.
 *
 * Pure and silent by contract: no writes, no logging, no HTTP, no
 * Transaction. It performs at most one platform read
 * (CustomerMgr.getCustomerByLogin) and at most one digest, so it is safe to
 * call twice per order (orderSyncGate calls it once, gameballOrderApi and
 * orderPayload.build() each call it again) and every call returns the same
 * value for the same order and the same preferences.
 * (Memoising this per-request was considered and rejected: SFCC's module
 * instance lifetime across requests is UNVERIFIED, and a stale cache on an
 * identity value is a far worse failure mode than one extra indexed
 * customer lookup on a confirmation page.)
 * @param {dw.order.Order} order
 * @returns {GameballOrderIdentity}
 */
function getOrderCustomerId(order) {
    if (!order) {
        return { customerId: '', guest: false, source: '', reason: REASON_NO_ORDER };
    }

    // Rung 1 - registered customer. Byte-identical to the pre-item-05
    // payload builder (customerId: profile.customerNo): no prefix, no
    // normalisation, no case change.
    var customer = order.getCustomer();
    var profile = customer && customer.getProfile();

    if (profile) {
        var customerNo = getRegisteredCustomerId(profile);
        if (!customerNo) {
            // Never fall through to a guest id here: handing a registered
            // shopper with a legacy/imported profile a gb_guest_* id would
            // permanently split their balance across two Gameball records.
            return { customerId: '', guest: false, source: '', reason: REASON_PROFILE_WITHOUT_CUSTOMER_NO };
        }
        return { customerId: customerNo, guest: false, source: SOURCE_PROFILE, reason: '' };
    }

    // Rung 2 - a guest order whose email resolves to an existing registered
    // login. guest stays false because the points genuinely land on a
    // registered Gameball profile, not a minted one.
    var linkByLogin = !!Site.getCurrent().getCustomPreferenceValue('gameballLinkGuestOrdersByLogin');
    if (linkByLogin) {
        var email = order.getCustomerEmail();
        if (email) {
            var matchedProfile = resolveProfileByLogin(email);
            if (matchedProfile) {
                var matchedNo = getRegisteredCustomerId(matchedProfile);
                if (matchedNo) {
                    return { customerId: matchedNo, guest: false, source: SOURCE_LOGIN_MATCH, reason: '' };
                }
            }
        }
    }

    // Rung 3 - true guest.
    return buildGuestIdentity(order);
}

module.exports = {
    getOrderCustomerId: getOrderCustomerId,
    getRegisteredCustomerId: getRegisteredCustomerId
};
