/**
 * Gameball widget loader.
 *
 * Hand-authored ES5, shipped verbatim from cartridge/static/default/js/ -
 * there is no webpack/gulp/compile:js step in this repo, so nothing
 * regenerates or clobbers this file (build-plan section 4.7: "Our own JS ships
 * from cartridge/static/default/js/").
 *
 * It reads the JSON data island that gameball/widget.isml emits and hands the
 * parsed object to GbSdk.init(). The island exists so that no
 * customer-controlled byte ever reaches a JavaScript parsing context: a
 * double-quoted HTML attribute is entity-decoded by the HTML parser before
 * getAttribute() sees it, so the platform's own encoder is simultaneously safe
 * and lossless. Do not "simplify" this back into an inline <script> in the
 * template - that is the stored-XSS shape this file exists to remove.
 *
 * 'use strict' sits inside the IIFE rather than at file scope (the one place
 * this cartridge departs from H1) because this is a browser script, not a
 * CommonJS module: a file-level directive would leak strict mode into anything
 * a merchant later concatenates after it.
 */
(function () {
    'use strict';

    // Hard-coded string literal, never read from a preference and never
    // concatenated from config. Build-plan section 4.7 requires the loader
    // origin to be validated rather than interpolated into <script src>; a
    // literal needs no validator because there is nothing to validate. It is
    // also deliberately not self-hosted or version-pinned - gameball-init.min.js
    // pins the widget bundle version internally, so a frozen copy would strand
    // the merchant on stale code (build-plan section 8.5).
    var GAMEBALL_LOADER_SRC = 'https://assets.gameball.co/widget/js/gameball-init.min.js';

    // Boot guard. A second copy of the fragment (two footers, a nested
    // include) must not init twice: GbSdk.init() unconditionally re-appends
    // both the 581 KB widget bundle AND the cdnjs SignalR script on every
    // call, stacking duplicate scripts and duplicate SignalR connections
    // (build-plan section 8.2).
    if (window.__gameballWidgetBooted) {
        return;
    }
    window.__gameballWidgetBooted = true;

    var el = document.getElementById('gameball-widget-config');
    if (!el) {
        // The static file uploaded but the fragment was suppressed (or vice
        // versa). Nothing to do, and nothing worth saying out loud.
        return;
    }

    var raw = el.getAttribute('data-gameball-config');
    if (!raw) {
        return;
    }

    var config;
    try {
        config = JSON.parse(raw);
    } catch (e) {
        // A malformed island must never throw into the merchant's page - the
        // client-side form of "a Gameball failure stays invisible to the
        // shopper" (H17). Deliberately silent: browser-console output is a
        // storefront-visible symptom, and H29 keeps it out of shipped code.
        return;
    }

    if (!config || !config.APIKey) {
        return;
    }

    var initialised = false;

    /**
     * Initialises the Gameball SDK at most once, whichever of the two entry
     * points (GbLoadInit or the script's own load event) fires first.
     * @returns {void}
     */
    function initOnce() {
        if (initialised) {
            return;
        }

        if (!window.GbSdk || !window.GbSdk.init) {
            // The loader ran but never defined GbSdk. Nothing to init against;
            // the next page view is the retry.
            return;
        }

        initialised = true;

        try {
            window.GbSdk.init(config);
        } catch (e) {
            // An SDK-internal failure must not break the storefront page.
        }
    }

    // Another include, or a merchant script, already loaded the SDK. Preserves
    // the else-branch GbSdk.init(payload) call of the template this replaces.
    if (window.GbSdk && window.GbSdk.init) {
        initOnce();
        return;
    }

    // CRITICAL: GbLoadInit must be assigned BEFORE the loader is appended, or
    // the loader throws and nothing renders (build-plan section 8.5). The
    // template this replaces never defined it at all and relied on script.onload
    // alone - a latent defect that stayed invisible only because a script that
    // throws still fires its load event.
    window.GbLoadInit = function () {
        initOnce();
    };

    var s = document.createElement('script');
    s.async = true;
    s.src = GAMEBALL_LOADER_SRC;

    // Belt and braces for the case where the loader never calls GbLoadInit.
    // The initialised flag inside initOnce makes the two entry points mutually
    // exclusive, so the SDK is initialised exactly once however the loader
    // behaves.
    s.onload = function () {
        initOnce();
    };

    s.onerror = function () {
        // Gameball's CDN is unreachable - the storefront is unaffected. No
        // retry: the next page view is the retry, and a retry loop against a
        // down CDN is worse than nothing.
    };

    // document.head is present in every modern browser, but a malformed
    // merchant theme can leave it null and appendChild on null would throw
    // out of this IIFE.
    (document.head || document.getElementsByTagName('head')[0] || document.body).appendChild(s);
}());
