'use strict';

var Site = require('dw/system/Site');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

// The canonical entry-point vocabulary, persisted verbatim into
// Profile.custom.gbSyncSource, whose description in the metadata enumerates
// exactly this set. UPPER_SNAKE because it is persisted state (H39), not a
// route id - a route id would tie a stored value to an SFRA controller name
// that a future release is free to rename.
//
// Only the two OCAPI families are gated by a preference. The storefront routes
// and the delta job are unconditional: they are already gated by
// gameballEnabled and, for the job, by its own trigger, and giving a merchant a
// switch that silently stops storefront registrations from syncing is a support
// case waiting to happen.
var SOURCE_OCAPI_SHOP_POST = 'OCAPI_SHOP_POST';
var SOURCE_OCAPI_SHOP_PATCH = 'OCAPI_SHOP_PATCH';
var SOURCE_OCAPI_DATA_POST = 'OCAPI_DATA_POST';
var SOURCE_OCAPI_DATA_PUT = 'OCAPI_DATA_PUT';
var SOURCE_OCAPI_DATA_PATCH = 'OCAPI_DATA_PATCH';

var SKIP_STATE = 'SKIPPED';

/**
 * Reads one boolean site preference, defaulting rather than failing.
 *
 * getCustomPreferenceValue returns null for an id that has not been imported -
 * it does not throw - which is the normal state during a code-then-metadata
 * release, on a second site the import did not target, and after a partial
 * import. Coercing straight to boolean would answer false there, so a missing
 * gameballSyncOcapiShopCustomers would silently disable the Shop-API path that
 * is documented as defaulting to ON. The fallback is what makes the
 * <default-value> in the metadata belt-and-braces rather than the only thing
 * standing between a merchant and a silently dead hook.
 *
 * @param {string} id - the site-preference id
 * @param {boolean} fallback - the value to use when the preference has no
 *        stored value at all, or cannot be read
 * @returns {boolean}
 */
function readBooleanPreference(id, fallback) {
    try {
        var site = Site.getCurrent();
        if (!site) {
            return fallback;
        }

        var value = site.getCustomPreferenceValue(id);
        if (value === null || value === undefined) {
            return fallback;
        }

        return !!value;
    } catch (e) {
        return fallback;
    }
}

/**
 * Null/exception-safe read of a profile's customer number.
 *
 * Guarded rather than read inline because this runs against a Profile that may
 * have been deleted between a search and this callback, and against argument
 * objects handed in by OCAPI hooks whose exact types are unverified. '' reads
 * correctly at the one call site: no customer number, no upsert key, no call.
 *
 * @param {dw.customer.Profile} profile
 * @returns {string} '' when the profile or the number is absent
 */
function getCustomerNo(profile) {
    try {
        return (profile && profile.customerNo) || '';
    } catch (e) {
        return '';
    }
}

/**
 * Null/exception-safe read of a profile's email address.
 * @param {dw.customer.Profile} profile
 * @returns {string} '' when the profile or the address is absent
 */
function getEmail(profile) {
    try {
        return (profile && profile.email) || '';
    } catch (e) {
        return '';
    }
}

/**
 * The single named enable predicate for every customer sync path.
 *
 * The same condition orderSyncGate.js:11-13 applies to orders, and deliberately
 * so: a caller must never be able to enable-check half of it (H37). This is
 * also where the local isGameballEnabled() that used to live in
 * gameballCustomerApi.js was relocated to - one predicate, one file, so the
 * customer side and the order side cannot drift apart.
 *
 * It differs from its order-side twin in exactly one way: the site handle is
 * read into a local and null-checked, the way readBooleanPreference above
 * already does. orderSyncGate is only ever reached from a storefront request,
 * where a site is guaranteed. This module is not - it is the FIRST rule
 * evaluate() applies, and it runs inside the OCAPI/SCAPI Data-API hooks, whose
 * base path is /s/-/dw/data/ where '-' literally means "no site". Whether
 * Site.getCurrent() is usable there is UNVERIFIED (no sandbox in this
 * environment; it is the same open question the erasure item's Data-API capture
 * depends on). Without the guard, a Data-API customer POST on an instance with
 * no site context would throw a TypeError here on EVERY record, sendProfile's
 * boundary catch would swallow it into one ERROR line per record, and a bulk
 * upsert would produce nothing but noise - for a source that ships switched
 * OFF. With it, a missing site degrades to a deliberate, documented skip that
 * writes nothing, and the delta sweep still covers those customers within one
 * schedule interval.
 *
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager; false when there is no
 * site context to read the preference from
 */
function isEnabled() {
    var site = Site.getCurrent();

    return !!site && !!site.getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * Is this entry point switched on?
 *
 * Only the OCAPI families are switchable, and they are switchable for opposite
 * reasons. The Shop API defaults ON because a headless registration is
 * semantically identical to a storefront one and should behave identically. The
 * Data API defaults OFF because its hook runs INSIDE the platform's own
 * database transaction (build-plan section 5.1 caveat ii), so a bulk CRM upsert
 * would hold one transaction open per record for the duration of a synchronous
 * Gameball call - and coverage is not lost by leaving it off, because the delta
 * sweep picks those same customers up within one schedule interval with zero
 * request-path risk.
 *
 * @param {string} source - one of the canonical values above
 * @returns {boolean}
 */
function isSourceEnabled(source) {
    if (source === SOURCE_OCAPI_SHOP_POST || source === SOURCE_OCAPI_SHOP_PATCH) {
        return readBooleanPreference('gameballSyncOcapiShopCustomers', true);
    }

    if (source === SOURCE_OCAPI_DATA_POST || source === SOURCE_OCAPI_DATA_PUT || source === SOURCE_OCAPI_DATA_PATCH) {
        return readBooleanPreference('gameballSyncDataApiCustomers', false);
    }

    return true;
}

/**
 * Decides whether a profile should ever be synced to Gameball from this entry
 * point, before any payload is built or any API call is made.
 *
 * This answers only "should we ever". The "have we already" question is the
 * gbSyncHash check in gameballCustomerApi.sendProfile - the same split
 * orderSyncGate.js:44-48 documents for orders, and for the same reason: one is
 * a policy about the profile, the other is a fact about the last call, and
 * merging them produces a predicate nobody can reason about.
 *
 * skipState is null for the first two rules and 'SKIPPED' for the rest, and the
 * difference is load-bearing rather than cosmetic. When there is no profile
 * there is nothing to write state onto; when the whole integration is off we
 * must not write Gameball attributes onto every profile a merchant happens to
 * touch, because that would put a Gameball-shaped state machine onto the
 * customer records of a merchant who has switched Gameball off.
 *
 * @param {dw.customer.Profile} profile
 * @param {string} source - one of ACCOUNT_SUBMIT_REGISTRATION |
 *        ACCOUNT_SAVE_PROFILE | ORDER_CREATE_ACCOUNT | OCAPI_SHOP_POST |
 *        OCAPI_SHOP_PATCH | OCAPI_DATA_POST | OCAPI_DATA_PUT |
 *        OCAPI_DATA_PATCH | DELTA_JOB | MERCHANT_API
 * @returns {{shouldSync: boolean, skipState: (string|null), reason: string}}
 */
function evaluate(profile, source) {
    if (!profile) {
        return { shouldSync: false, skipState: null, reason: 'no_profile' };
    }

    if (!isEnabled()) {
        return { shouldSync: false, skipState: null, reason: 'gameball_disabled' };
    }

    if (!isSourceEnabled(source)) {
        return { shouldSync: false, skipState: SKIP_STATE, reason: 'source_disabled' };
    }

    if (!getCustomerNo(profile)) {
        // customerId is the upsert's idempotent key and is Required: Yes. An
        // empty one earns a guaranteed 3001 and spends one of the
        // 360-per-30-seconds customer-POST budget to do it.
        return { shouldSync: false, skipState: SKIP_STATE, reason: 'no_customer_no' };
    }

    if (readBooleanPreference('gameballCustomerRequireEmail', false) && !getEmail(profile)) {
        // A data-quality gate, NOT a consent gate - consent gating is out of
        // scope by decision and this preference must never be documented as
        // one. It exists because a Gameball workspace using email-based channel
        // merging cannot merge a record with no email, so such a record becomes
        // a permanently orphaned Gameball profile. Default off, which preserves
        // today's behaviour exactly.
        return { shouldSync: false, skipState: SKIP_STATE, reason: 'no_email' };
    }

    return { shouldSync: true, skipState: null, reason: '' };
}

module.exports = {
    isEnabled: isEnabled,
    evaluate: evaluate
};
