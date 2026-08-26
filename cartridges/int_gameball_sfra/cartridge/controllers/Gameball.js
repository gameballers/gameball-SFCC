'use strict';

var server = require('server');
// NOTE: no server.extend(module.superModule) - there is no base Gameball
// controller to extend, and calling extend with an undefined superModule
// throws. server.replace is banned outright (H44) and is not used anywhere.

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.widget');
var gameballJson = require('*/cartridge/scripts/util/gameballJson');
var widgetPayload = require('*/cartridge/models/payload/widgetPayload');

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

module.exports = server.exports();
