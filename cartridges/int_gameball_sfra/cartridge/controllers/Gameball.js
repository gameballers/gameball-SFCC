'use strict';

var server = require('server');
// NOTE: no server.extend(module.superModule) - there is no base Gameball
// controller to extend, and calling extend with an undefined superModule
// throws. server.replace is banned outright (H44) and is not used anywhere.

var Site = require('dw/system/Site');
var BasketMgr = require('dw/order/BasketMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.widget');
// Required eagerly, against the late-require pattern the rest of this file
// uses for gameballCredentials/gameballRedemptionApi below - those are late
// because LocalServiceRegistry.createService runs at module load and this
// file's module-load path must survive a broken/un-imported Gameball
// service (see resolveViewData's own comment on the same subject).
// csrfProtection has no such side effect - it is the same stock SFRA
// middleware module Cart.js already requires eagerly at its own top
// (Cart.js:8) - so there is nothing here for a boundary try/catch to need to
// contain.
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var gameballJson = require('*/cartridge/scripts/util/gameballJson');
var widgetPayload = require('*/cartridge/models/payload/widgetPayload');
var gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');
var redemptionStateStore = require('*/cartridge/scripts/redemption/redemptionStateStore');
var redemptionReconcile = require('*/cartridge/scripts/redemption/redemptionReconcile');

/**
 * Resolves everything the widget fragment needs for the CURRENT session.
 *
 * Split out of the route body purely so the two configuration guards can
 * return early. Returning early from the route itself would skip res.render
 * and leave the include with no response; nesting the guards as if/else
 * instead would bury the payload build three levels deep for no gain.
 *
 * @param {Object} req - the SFRA request wrapper
 * @returns {{render: boolean, configJson: string}} render:false means emit
 *   nothing at all - not an empty widget, not a placeholder
 */
function resolveViewData(req) {
    // The fix for the defect that made this widget dead: 'gameballEnabled' is
    // the only id that exists in system-objecttype-extensions.xml:5. The
    // template used to read 'Gameball_Enabled', and getCustomPreferenceValue
    // returns null for an undefined id, so the enable check was never true and
    // no merchant has ever seen the widget render. Exactly one id, no alias
    // (H36) - a dual-alias lookup is what allowed the mismatch to survive review.
    if (!Site.getCurrent().getCustomPreferenceValue('gameballEnabled')) {
        return { render: false, configJson: '' };
    }

    // Late require, against H2, for a stated reason: requiring
    // gameballCredentials runs LocalServiceRegistry.createService at MODULE
    // load, and a module-load throw happens before this route's try block
    // exists. On an instance where services.xml was never imported or the
    // gameball.http.api service was deleted in BM, that would fail the whole
    // controller module - and because pageFooter.isml remote-includes this
    // route on every page, the Web Adapter would substitute an error fragment
    // site-wide instead of substituting nothing, which is precisely the H17
    // violation this route exists to prevent. Requiring it here puts service
    // construction inside the boundary catch and, as a bonus, means a merchant
    // who has Gameball switched off never touches the service registry at all.
    var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

    // The credential half of the enable check, kept separate from the flag so
    // the debug line can say which half failed. Together these two reproduce
    // the old template's isEnabled-and-non-empty-apiKey semantics (I16) and
    // mirror orderSyncGate.isGameballEnabled() (H37).
    var apiKey = gameballCredentials.getApiKey();
    if (!apiKey) {
        // Deliberately not Logger.error: a merchant who has turned Gameball on
        // but not yet pasted the credential is mid-setup, not broken. Not
        // preference-gated either - no gameballDebugLogEnabled preference
        // ships in this cartridge yet, and reading one that does not exist is
        // the exact kind of defect this PR fixes (H43). SFCC's own log-level
        // switch is the gate until that preference lands.
        Logger.debug('Gameball widget suppressed: gameballEnabled is on but the gameball.http.api.cred credential has no API Key.');
        return { render: false, configJson: '' };
    }

    var raw = req.currentCustomer && req.currentCustomer.raw;

    // CRITICAL: the authenticated === true test is the whole authorisation
    // check. SFRA's request wrapper deliberately withholds the profile for a
    // remembered-but-not-authenticated session, but raw.profile IS populated
    // (build-plan section 8.2) - reading raw.profile alone would hand a real
    // customerNo, full name and email to a visitor holding nothing but a
    // "remember me" cookie.
    var profile = (raw && raw.authenticated === true && raw.profile) ? raw.profile : null;

    var localeId = (req.locale && req.locale.id) || request.getLocale() || '';

    var payload = widgetPayload.build(profile, localeId, apiKey);
    var configJson = gameballJson.toEmbeddableJson(payload);

    if (!configJson) {
        throw new Error('Gameball widget config serialised to an empty string');
    }

    return { render: true, configJson: configJson };
}

/**
 * Renders the Gameball widget fragment for the CURRENT session.
 *
 * Remote-include only. It exists as a separate uncached request so that the
 * shopper-scoped payload is never written into the page cache entry of a
 * cached PLP/PDP/home page (build-plan section 8.3). SFCC page-cache keys do
 * not include the customer, so a footer that emitted this inline would re-serve
 * one shopper's name and email to every subsequent visitor - which is why
 * repairing the enable check and moving to a remote include had to ship in the
 * same change. The cost is one app-server request per page view, including on
 * fully-cached pages; the rejected alternative (a client fetch to a
 * Gameball-Identity endpoint, build-plan section 8.2) costs the same
 * app-server hit PLUS a round trip PLUS a session per cookie-less bot hit.
 *
 * There is deliberately no <iscache> in gameball/widget.isml: SFCC caching is
 * opt-in, and an <iscache> inside an included template would apply to the
 * enclosing page.
 *
 * server.middleware.include is a hygiene guard, not a security control: it
 * rejects a direct browser hit on the route. The route is safe without it -
 * it only ever returns the CALLER'S OWN session identity, so there is nothing
 * to enumerate - and its presence in this SFRA version is UNVERIFIED (the
 * SFRA base is not vendored in this repo, and there is no sandbox in this
 * environment). If it does not resolve, delete the argument; the documented
 * alternative is dw.system.Request#isIncludeRequest(), itself unverified.
 *
 * @name Base/Gameball-Widget
 * @function
 * @memberof Gameball
 * @param {middleware} - server.middleware.include
 * @param {category} - non-sensitive
 * @param {renders} - isml
 * @param {serverfunction} - get
 */
server.get('Widget', server.middleware.include, function (req, res, next) {
    // Initialised before the try so a throw anywhere below still leaves a
    // renderable (empty) fragment - the boundary catch must never be able to
    // leave res.render uncalled.
    var viewData = { render: false, configJson: '' };

    try {
        viewData = resolveViewData(req);
    } catch (e) {
        // H17: the only job of this catch is to log and allow the page to render
        // without the widget. Worst case is a storefront page with no loyalty
        // launcher - never a broken or delayed page.
        //
        // What this catch still cannot cover: anything that throws while this
        // module is being evaluated, i.e. the requires above. They are limited
        // to the SFRA server module and side-effect-free modules for exactly
        // that reason - gameballCredentials, the one require with a
        // service-registry side effect, is deliberately late (see
        // resolveViewData). A throw up there is a failed remote include, not a
        // suppressed widget.
        Logger.error('Gameball widget suppressed: {0}', e && e.message);
    }

    res.render('gameball/widget', { gameballWidget: viewData });

    return next();
});

/**
 * Resolves Pay with Points state for the CURRENT session: balance, live
 * hold, and a server-computed spend cap. Returns { enabled: false, ... }
 * (never a partial/placeholder shape) the moment any prerequisite is unmet -
 * same early-return pattern as resolveViewData above.
 *
 * gameballRedemptionApi is required INSIDE this function, not at module
 * top, for the same reason gameballCredentials is a late require in
 * resolveViewData: Gameball-Widget is remote-included on every page via
 * pageFooter.isml, and this file's module-load path must stay free of
 * anything with a LocalServiceRegistry.createService side effect - a broken
 * or un-imported gameball.http.api service must never be able to take down
 * the sitewide widget too, only this route.
 *
 * @param {Object} req - the SFRA request wrapper
 * @returns {Object} the JSON body to serve
 */
function resolveRedeemState(req) {
    if (!Site.getCurrent().getCustomPreferenceValue('gameballEnabled')) {
        return { enabled: false };
    }

    var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
    if (!gameballCredentials.getApiKey()) {
        return { enabled: false };
    }

    if (!Site.getCurrent().getCustomPreferenceValue('gameballEnableRedemption')) {
        return { enabled: false, reason: 'redemption_disabled' };
    }

    // CRITICAL: authenticated === true is the whole authorisation check -
    // see the identical guard's own comment in resolveViewData above.
    var raw = req.currentCustomer && req.currentCustomer.raw;
    if (!raw || raw.authenticated !== true) {
        return { enabled: false, reason: 'not_authenticated' };
    }

    var customerId = gameballIdentity.getRegisteredCustomerId(raw.profile);
    if (!customerId) {
        return { enabled: false, reason: 'no_customer_id' };
    }

    var basket = BasketMgr.getCurrentBasket();
    if (!basket) {
        return { enabled: false, reason: 'no_basket' };
    }

    var gameballRedemptionApi = require('*/cartridge/scripts/api/gameballRedemptionApi');
    var balance = gameballRedemptionApi.getBalance(customerId);
    if (!balance.ok || !balance.body) {
        // Never surface a raw Gameball error to the browser - a balance
        // lookup failure just means the feature quietly does not offer
        // itself this page view.
        return { enabled: false, reason: 'balance_unavailable' };
    }

    var currentHold = redemptionStateStore.readHold(basket);
    var caps = redemptionReconcile.computeCaps(basket);

    var availablePointsBalance = Number(balance.body.availablePointsBalance) || 0;
    var availablePointsValue = Number(balance.body.availablePointsValue) || 0;
    var pointsPerCurrencyUnit = availablePointsValue > 0 ? (availablePointsBalance / availablePointsValue) : 0;

    // A CLIENT-FACING ESTIMATE ONLY, converting the server-computed currency
    // cap (caps.maxHoldAmount) into an approximate points ceiling for the
    // slider. Never authoritative: Cart-Redeem re-validates the requested
    // points against the shopper's fresh balance and this same cap
    // server-side before ever calling Gameball, and also handles the case
    // where Gameball's own point-to-currency rounding differs from this
    // estimate (releasing an over-cap hold immediately - see Cart.js).
    var maxRedeemablePoints = pointsPerCurrencyUnit > 0
        ? Math.min(availablePointsBalance, Math.floor(caps.maxHoldAmount * pointsPerCurrencyUnit))
        : 0;

    return {
        enabled: true,
        pointsName: balance.body.pointsName || '',
        currency: balance.body.currency || '',
        availablePointsBalance: availablePointsBalance,
        availablePointsValue: availablePointsValue,
        pendingPoints: Number(balance.body.pendingPoints) || 0,
        currentHold: currentHold,
        maxRedeemablePoints: maxRedeemablePoints > 0 ? maxRedeemablePoints : 0,
        minOrderAmount: Number(Site.getCurrent().getCustomPreferenceValue('gameballRedemptionMinOrderAmount')) || 0
    };
}

/**
 * Serves Pay with Points state as plain JSON for the CURRENT session.
 *
 * A plain, directly browser-fetchable route - NOT server.middleware.include.
 * Unlike Widget (embedded at render time into every page via the footer
 * hook, so it must never leak shopper data into a cached page render), this
 * is fetched client-side, lazily, only on cart/checkout - two page types,
 * not every page - so there is no cached-page-embedding hazard to guard
 * against here in the first place.
 *
 * csrfProtection.generateToken is wired into THIS route, and must never be
 * wired anywhere near gameball/redeemInjector.isml or its afterFooter hook.
 * That fragment's own header comment spells out why: it renders on cached
 * AND uncached page loads alike and is documented to emit only static,
 * non-shopper-scoped markup, because SFCC's page-cache key does not include
 * the customer or the session - a token minted for one shopper's session
 * embedded there would be replayed to every subsequent visitor served that
 * same cache entry, which is a real CSRF-bypass hazard for other shoppers,
 * not merely a cosmetic one. This route carries no such risk: it is fetched
 * lazily by gameballRedeem.js after the page has already rendered, is never
 * cached itself (server.middleware.https, no <iscache> anywhere in this
 * response path), and mints a fresh token bound to the CALLER'S OWN session
 * on every request - exactly the "fetched fresh every time" contract
 * dw.web.CSRFProtection tokens require.
 *
 * @name Base/Gameball-RedeemState
 * @function
 * @memberof Gameball
 * @param {middleware} - server.middleware.https
 * @param {middleware} - csrfProtection.generateToken
 * @param {category} - sensitive (authenticated shopper's points balance,
 *   plus a session-bound CSRF token - see the note above on why this is the
 *   only route in the cartridge allowed to mint one)
 * @param {renders} - json
 * @param {serverfunction} - get
 */
server.get('RedeemState', server.middleware.https, csrfProtection.generateToken, function (req, res, next) {
    var viewData = { enabled: false };

    try {
        viewData = resolveRedeemState(req);
    } catch (e) {
        // H17: a Gameball failure here must only mean the redeem panel does
        // not render - never a broken cart/checkout page.
        Logger.error('Gameball redeem-state lookup failed: {0}', e && e.message);
        viewData = { enabled: false };
    }

    // Attached here, after resolveRedeemState returns, rather than inside it:
    // this keeps the CSRF attachment to exactly one place regardless of which
    // of resolveRedeemState's several early-return branches fired (feature
    // off, no credential, redemption off, unauthenticated, no basket, balance
    // lookup failed), instead of repeating the same two lines in six spots or
    // threading res.locals through resolveRedeemState's signature just to
    // reach this one field. res.locals.csrf is only populated when the
    // generateToken middleware above actually ran and minted a token, so the
    // guard also covers the case where that middleware itself is ever removed
    // or fails open - the response degrades to no csrf key rather than a
    // half-built one. gameballRedeem.js reads csrf.tokenName as the POST
    // field name and csrf.token as its value for both Cart-Redeem and
    // Cart-RedeemRemove, rather than the cookie-based double-submit pattern
    // the panel used to (and SFCC's dw.web.CSRFProtection does not implement,
    // hence CSRF-AjaxFail on every Apply/Remove before this fix) - see
    // gameballRedeem.js for the client-side half.
    if (res.locals.csrf) {
        viewData.csrf = { token: res.locals.csrf.token, tokenName: res.locals.csrf.tokenName };
    }

    res.json(viewData);

    return next();
});

module.exports = server.exports();
