'use strict';

// Gameball's own docs conflict on regional codes (zh-tw vs zh-TW, dk vs
// da-DK), so only the language segment is ever sent and anything that does not
// look like a language code falls back to English. Build-plan section 8.5
// names a gameballWidgetLangMap preference as the real fix; that preference is
// deliberately not added here (spec 01 section 3), so the fallback is English
// regardless of the site's default locale.
var GAMEBALL_LANG_FALLBACK = 'en';

// platform: Gameball's documented Platform enum (plan section 13.9) has no
// 'salesforce' member - the enum is shopify|wp|magento|zid|bigcommerce|
// dokkan*|zammit|wuilt|salla. Plan section 8.5 mandates the literal 'any'
// instead. Kept as 'salesforce' deliberately: changing a value the Gameball
// workspace may already be keyed on is a product decision, not a security fix,
// and the only documented consequence (a dead applyCoupon() button) is
// unreachable while redemption is out of scope. Open question for Gameball:
// add a 'salesforce' member, or switch this to 'any'.
var GAMEBALL_PLATFORM = 'salesforce';

/**
 * True when a profile field holds nothing worth sending. Whitespace counts as
 * empty: GbSdk.init with playerAttributes is a WRITE path (plan section 13.9),
 * so sending ' ' would blank a name the server-side integrations/customers
 * upsert set correctly seconds earlier.
 * @param {string} value
 * @returns {boolean}
 */
function isBlank(value) {
    return !value || !String(value).trim();
}

/**
 * Maps an SFCC locale id to the GbSdk lang option.
 * Internal - not exported (H6: export only what a sibling genuinely needs).
 *
 * 'default' is SFCC's site-default locale id, not a language, and today's
 * template forwards it verbatim; GbSdk has no 'default' language table, so it
 * is mapped to the fallback here. Region/script variants are dropped rather
 * than mapped, because mapping them correctly needs the lang-map preference
 * this item deliberately does not add.
 *
 * @param {string} localeId - e.g. 'en_US', 'ar-EG', 'default', ''
 * @returns {string} a lowercase 2-3 letter language code, or 'en'
 */
function toGameballLang(localeId) {
    if (!localeId || typeof localeId !== 'string') {
        return GAMEBALL_LANG_FALLBACK;
    }

    var segment = localeId.split(/[_-]/)[0].toLowerCase();

    if (!/^[a-z]{2,3}$/.test(segment)) {
        return GAMEBALL_LANG_FALLBACK;
    }

    return segment;
}

/**
 * Builds the options object passed to GbSdk.init() in the browser.
 * Contract: build-plan section 13.9 (widget) and section 8.5 (field mapping).
 *
 * Pure function of its arguments - zero reads of req, res, pdict, session,
 * request or customer (H30), so the same builder serves a future headless
 * front end unchanged.
 *
 * Optional attributes are OMITTED rather than sent empty (H31). That is a bug
 * fix, not a cosmetic change: the widget is a documented write path, so the
 * firstName: '', lastName: '', email: '' and displayName: ' ' today's template
 * sends for a half-populated profile are an instruction to Gameball to blank
 * those fields on every page view.
 *
 * @param {dw.customer.Profile|null} profile - null for a guest/anonymous
 *   session; the caller is responsible for having confirmed
 *   customer.authenticated === true before passing a profile
 * @param {string} localeId - SFCC locale id, e.g. req.locale.id
 * @param {string} apiKey - the PUBLIC Gameball workspace key
 *   (gameballCredentials.getApiKey()). Never the Secret Key. The caller is
 *   responsible for having confirmed it is non-empty - there is no placeholder
 *   worth substituting (H31), so an empty key simply produces a config the
 *   client-side loader refuses to initialise with.
 * @returns {{APIKey: string, playerUniqueId: string, lang: string, platform: string,
 *            playerAttributes: (Object|undefined)}} the GbSdk.init() options
 */
function build(profile, localeId, apiKey) {
    var payload = {
        APIKey: apiKey,
        // Always emitted, even for a guest. '' is Gameball's documented
        // guest-view contract (plan section 13.9) and creates no profile;
        // today's template omits the field entirely for guests, which is
        // undocumented behaviour rather than a supported one.
        playerUniqueId: '',
        lang: toGameballLang(localeId),
        platform: GAMEBALL_PLATFORM
    };

    if (!profile) {
        return payload;
    }

    // An imported or malformed profile can be authenticated and still carry no
    // customerNo. Fall through to the guest view rather than send null as an
    // identity (H31) - a null playerUniqueId would either be rejected or, far
    // worse, mint a Gameball profile keyed on nothing.
    if (isBlank(profile.customerNo)) {
        return payload;
    }

    payload.playerUniqueId = profile.customerNo;

    // OPEN RISK - what this attribute set OMITS is unsettled, not decided.
    // Gameball's merge semantics on a repeat upsert are an unanswered BLOCKING
    // question (plan section 6.9 Q1, arbitration risk R-8, which names this
    // item): nobody knows whether leaving a customerAttributes field out of an
    // upsert retains the stored value or nulls it. The divergence that matters
    // is dateOfBirth - customerPayload.build sends it server-side, this builder
    // never does. Under replace-not-merge semantics, repairing the enable check
    // makes GbSdk.init fire on every page view and clear that shopper's
    // birthday every single time, so birthday campaigns silently stop firing
    // with no error on either side (the SDK exposes no error callback).
    // Deliberately NOT fixed by adding dateOfBirth here: that expands the PII
    // surface of a change whose purpose is to shrink it, and R-8 forbids
    // expanding the attribute set until Gameball answers. Settle R-8 first -
    // upsert with dateOfBirth, upsert again without it, GET the profile.
    var attributes = {};

    // Same expression as customerPayload.js:11 so the widget's write path and
    // the server-side integrations/customers upsert never disagree on the
    // value they race each other to store (spec 01 edge case WRT-1).
    var displayName = ((profile.firstName || '') + ' ' + (profile.lastName || '')).trim();
    if (displayName) {
        attributes.displayName = displayName;
    }
    if (!isBlank(profile.firstName)) {
        attributes.firstName = profile.firstName;
    }
    if (!isBlank(profile.lastName)) {
        attributes.lastName = profile.lastName;
    }
    if (!isBlank(profile.email)) {
        attributes.email = profile.email;
    }

    // A profile with nothing populated sends no playerAttributes key at all,
    // rather than an empty object - Gameball treats the key as an update
    // instruction, and "update with nothing" is not a thing worth asking for.
    if (Object.keys(attributes).length > 0) {
        payload.playerAttributes = attributes;
    }

    return payload;
}

module.exports = {
    build: build
};
