/**
 * Pay with Points client-side panel.
 *
 * Hand-authored ES5, shipped verbatim from cartridge/static/default/js/ -
 * same convention as gameballWidget.js: no webpack/gulp/compile:js step in
 * this repo, so nothing regenerates or clobbers this file, and no ES6+
 * syntax is used even though every realistic target browser supports it,
 * for consistency with that file and because there is no build step to
 * transpile a mistake away.
 *
 * Detects an eligible page (cart/checkout), fetches Gameball-RedeemState,
 * and renders a balance/slider panel next to the page's own order-totals
 * summary. Fails silently at every step (H17's client-side form, matching
 * gameballWidget.js) - worst case is no panel, never a broken page.
 *
 * 'use strict' sits inside the IIFE rather than at file scope, same as
 * gameballWidget.js, for the same reason: this is a browser script, not a
 * CommonJS module.
 */
(function () {
    'use strict';

    // Boot guard - a second copy of the fragment must not attach twice.
    if (window.__gameballRedeemBooted) {
        return;
    }
    window.__gameballRedeemBooted = true;

    var root = document.getElementById('gameball-redeem-root');
    if (!root) {
        return;
    }

    var redeemStateUrl = root.getAttribute('data-redeem-state-url');
    var redeemUrl = root.getAttribute('data-redeem-url');
    var redeemRemoveUrl = root.getAttribute('data-redeem-remove-url');
    if (!redeemStateUrl || !redeemUrl || !redeemRemoveUrl) {
        return;
    }

    // UNVERIFIED (no sandbox in this environment): that SFRA's
    // common/layout/page.isml stamps data-action="${pdict.action}" on
    // <html>. This is a widely-documented SFRA convention, not a guaranteed
    // one - if it is absent on this instance, isEligiblePage() below falls
    // through to the CSS-selector fallback instead.
    var ELIGIBLE_ACTIONS = {
        'Cart-Show': true,
        'Checkout-Begin': true,
        'CheckoutServices-Get': true
    };

    // Fallback selectors for a page that carries no recognisable
    // data-action, or a merchant theme that overrides it - the same
    // selectors insertPanel() below tries for placement. Feature-detect,
    // never assume (mirrors Gameball-Widget's own "worst case is no
    // launcher" philosophy) - a merchant's custom theme with none of these
    // selectors simply never sees this panel, silently.
    var SUMMARY_SELECTORS = [
        '.order-total-summary',
        '.cart-totals',
        '.order-summary',
        '.totals',
        '#cart-table-summary'
    ];

    /**
     * @returns {boolean}
     */
    function isEligiblePage() {
        var action = document.documentElement && document.documentElement.getAttribute('data-action');
        if (action && ELIGIBLE_ACTIONS[action]) {
            return true;
        }

        // No usable data-action - fall back to whether a known summary
        // container is even present. If neither signal fires, this is not
        // treated as an eligible page at all (never a guess).
        return !!findSummaryContainer();
    }

    /**
     * @returns {Element|null}
     */
    function findSummaryContainer() {
        for (var i = 0; i < SUMMARY_SELECTORS.length; i++) {
            var el = document.querySelector(SUMMARY_SELECTORS[i]);
            if (el) {
                return el;
            }
        }
        return null;
    }

    if (!isEligiblePage()) {
        return;
    }

    /**
     * @param {string} url
     * @param {Object} params - form fields
     * @param {function(Object)} onSuccess - called with the parsed JSON body
     * @param {function()} onError
     * @returns {void}
     */
    function postForm(url, params, onSuccess, onError) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    onError();
                    return;
                }

                try {
                    onSuccess(JSON.parse(xhr.responseText));
                } catch (e) {
                    onError();
                }
            };

            xhr.onerror = function () {
                onError();
            };

            var pairs = [];
            var key;
            for (key in params) {
                if (Object.prototype.hasOwnProperty.call(params, key)) {
                    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
                }
            }
            xhr.send(pairs.join('&'));
        } catch (e) {
            onError();
        }
    }

    /**
     * @param {string} url
     * @param {function(Object)} onSuccess
     * @param {function()} onError
     * @returns {void}
     */
    function getJson(url, onSuccess, onError) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    onError();
                    return;
                }

                try {
                    onSuccess(JSON.parse(xhr.responseText));
                } catch (e) {
                    onError();
                }
            };

            xhr.onerror = function () {
                onError();
            };

            xhr.send();
        } catch (e) {
            onError();
        }
    }

    // No resource-bundle / localisation wiring exists for this feature yet
    // (int_gameball_sfra ships no .properties bundle at all - see
    // gameballWidget.js's own siblings). English-only copy is an accepted,
    // explicit v1 scope limit, not an oversight.
    var ERROR_COPY = {
        insufficient_points: 'You do not have enough points for that amount.',
        amount_too_large: 'That amount is too large for this order.',
        invalid_amount: 'Please choose a valid points amount.',
        balance_unavailable: 'Your points balance is unavailable right now.',
        not_authenticated: '',
        redemption_disabled: '',
        empty_basket: '',
        hold_already_live: 'You already have points applied - remove them first.',
        try_again: 'Something went wrong. Please try again.',
        internal_error: 'Something went wrong. Please try again.'
    };

    // Bootstrap 4 (BS4) utility/component classes, used below via
    // element.className instead of the hand-rolled inline
    // element.style.cssText strings this panel shipped with originally.
    // Named UPPER_SNAKE_CASE constants per house style (H7), and because the
    // panel class is genuinely identical between renderApplyForm's and
    // renderAppliedState's wrap element - a single constant is also the only
    // way to keep the two in sync if it is ever restyled again.
    //
    // This assumes the storefront theme loads BS4 - the SFRA reference
    // architecture's own default, and grep-confirmed live in the sibling
    // Yotpo loyalty cartridge's shipped templates: card/card-body,
    // form-control, btn btn-primary/btn-block, and the grid/text utilities
    // all appear throughout checkout.isml and confirmation.isml. Notably,
    // the exact '.order-total-summary' selector this file's own
    // SUMMARY_SELECTORS constant (above) targets for panel placement already
    // sits inside a BS4 <div class="card-body order-total-summary"> in that
    // reference markup - direct evidence this panel's insertion point is
    // itself Bootstrap-themed. custom-range/text-danger/btn-outline-secondary
    // and the mb-*/mt-*/my-* spacing utilities are core BS4 classes shipped
    // in every default BS4 build rather than an optional plugin, but were
    // never exercised by Yotpo's own markup, so - UNVERIFIED - there is no
    // repo-local grep hit to cite for those four specifically, and none of
    // this has been checked against any one merchant's live compiled CSS.
    //
    // The rejected alternative was leaving the original inline-style
    // literals in place: those render as a plain grey box with browser-
    // default buttons that visually clashes against a Bootstrap-themed
    // cart/checkout page's own card/button chrome, right next to the very
    // '.order-total-summary' card this panel is inserted beside. Swapping to
    // className cannot make things worse if the assumption is wrong, though
    // - an unrecognised class name is simply inert, never a thrown error and
    // never a hidden panel, so a merchant not running Bootstrap sees the same
    // plain-but-functional HTML this panel has always degraded to on any
    // other missing-precondition path in this file (H17's client-side form).
    var PANEL_CLASS = 'card card-body mb-3';
    var PANEL_LINE_CLASS = 'mb-2';
    var SLIDER_CLASS = 'custom-range';
    var SELECTED_LINE_CLASS = 'my-2';
    var APPLY_BUTTON_CLASS = 'btn btn-primary';
    var REMOVE_BUTTON_CLASS = 'btn btn-outline-secondary btn-sm';
    var MESSAGE_LINE_CLASS = 'text-danger small mt-2';

    /**
     * Reloads the current page after a successful Apply or Remove, rather
     * than only re-fetching and re-rendering THIS panel via fetchAndRender.
     *
     * A successful Apply/Remove changes the basket's own PriceAdjustment,
     * which moves the page's OWN order-totals summary (subtotal, discount
     * line, grand total, tax) - markup this script never wrote and has no
     * reach into. fetchAndRender alone left that summary showing the
     * pre-Apply/pre-Remove numbers until a manual page refresh, which is
     * exactly the bug this function exists to close.
     *
     * The correct-in-general fix would hook into whatever AJAX/event
     * mechanism this storefront's own cart/checkout JS already uses to
     * refresh its totals after a basket change (base SFRA cartridges
     * typically re-fetch a totals fragment or trigger a custom event other
     * components listen for) - but this session has already found this
     * particular SFRA fork diverging from generic SFRA assumptions twice
     * (CheckoutShippingServices being a separate controller from
     * CheckoutServices; the CSRF middleware populating res.getViewData()
     * rather than res.locals), so guessing a third undocumented internal
     * (an event name, a fragment endpoint) risks shipping something that
     * silently does nothing on this instance, same as the original bug.
     * A full reload is unglamorous - it gives up the AJAX panel's own
     * snappier feel for this one moment - but it is guaranteed correct on
     * any theme/version, matches the user's own confirmed manual
     * workaround, and touches nothing about how this storefront's totals
     * actually re-render. Swap this for a targeted totals refresh once
     * that mechanism is confirmed on a live sandbox.
     * @returns {void}
     */
    function reloadForFreshTotals() {
        window.location.reload();
    }

    function formatMoney(amount, currency) {
        var value = (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2);
        return currency ? (value + ' ' + currency) : value;
    }

    /**
     * Builds the panel markup for a NO-live-hold state: balance line,
     * slider, Apply button. Styled via the BS4 class constants declared
     * above (see that block's comment for why className replaced this
     * function's original inline style.cssText strings, and what a
     * non-Bootstrap theme falls back to).
     * @param {Object} state - a Gameball-RedeemState response
     * @param {Element} container
     * @returns {void}
     */
    function renderApplyForm(state, container) {
        container.innerHTML = '';

        var wrap = document.createElement('div');
        wrap.className = PANEL_CLASS;

        var balanceLine = document.createElement('div');
        balanceLine.textContent = 'You have ' + state.availablePointsBalance + ' '
            + (state.pointsName || 'points') + ' = ' + formatMoney(state.availablePointsValue, state.currency) + ' available';
        balanceLine.className = PANEL_LINE_CLASS;
        wrap.appendChild(balanceLine);

        if (state.maxRedeemablePoints <= 0) {
            container.appendChild(wrap);
            return;
        }

        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(state.maxRedeemablePoints);
        slider.step = '1';
        slider.value = '0';
        // No width:100% here - BS4's own stylesheet already sets that on
        // .custom-range, so restating it inline would just be dead weight
        // riding along on every page that DOES have Bootstrap, for zero
        // benefit on a page that does not.
        slider.className = SLIDER_CLASS;

        var selectedLine = document.createElement('div');
        selectedLine.className = SELECTED_LINE_CLASS;

        var pointsPerCurrencyUnit = state.availablePointsValue > 0
            ? (state.availablePointsBalance / state.availablePointsValue) : 0;

        function updateSelectedLine() {
            var points = parseInt(slider.value, 10) || 0;
            var value = pointsPerCurrencyUnit > 0 ? (points / pointsPerCurrencyUnit) : 0;
            selectedLine.textContent = points + ' ' + (state.pointsName || 'points') + ' = '
                + formatMoney(value, state.currency) + ' discount';
        }

        slider.addEventListener('input', updateSelectedLine);
        updateSelectedLine();

        var applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.textContent = 'Apply Points';
        applyButton.className = APPLY_BUTTON_CLASS;

        var messageLine = document.createElement('div');
        messageLine.className = MESSAGE_LINE_CLASS;

        applyButton.addEventListener('click', function () {
            var points = parseInt(slider.value, 10) || 0;
            if (points <= 0) {
                return;
            }

            applyButton.disabled = true;
            messageLine.textContent = '';

            // The field name/value pair here are whatever
            // csrfProtection.generateToken minted on the Gameball-RedeemState
            // fetch that produced THIS render of the panel (see Gameball.js's
            // RedeemState route for why that is the only place in the
            // cartridge allowed to mint one) - built as a dynamically-keyed
            // object rather than a hardcoded csrf_token property because
            // SFRA's own tokenName is an implementation detail of that
            // middleware, not a contract this file should hardcode a guess
            // at. This replaces the previous readCsrfToken(), which read a
            // csrf_token COOKIE via document.cookie: that is the
            // double-submit-cookie pattern, and dw.web.CSRFProtection does
            // not implement it - no code path in this cartridge ever wrote
            // that cookie, so the field was always sent empty and every
            // Apply/Remove failed CSRF-AjaxFail. If state.csrf is missing
            // (generateToken did not run - a defect elsewhere, never a
            // Gameball code path), the field is simply omitted rather than
            // sent as a blank/dummy value: an omitted field and a wrong one
            // both fail Cart-Redeem's validateAjaxRequest identically, so
            // there is nothing a fallback value would buy here.
            var formParams = { points: points };
            if (state.csrf && state.csrf.tokenName) {
                formParams[state.csrf.tokenName] = state.csrf.token;
            }

            postForm(redeemUrl, formParams, function (result) {
                if (result && result.success) {
                    // Full reload, deliberately, rather than only
                    // re-fetching this panel - see reloadForFreshTotals's own
                    // comment for why.
                    reloadForFreshTotals();
                    return;
                }

                applyButton.disabled = false;
                messageLine.textContent = (result && ERROR_COPY[result.error]) || ERROR_COPY.try_again;
            }, function () {
                applyButton.disabled = false;
                messageLine.textContent = ERROR_COPY.try_again;
            });
        });

        wrap.appendChild(slider);
        wrap.appendChild(selectedLine);
        wrap.appendChild(applyButton);
        wrap.appendChild(messageLine);
        container.appendChild(wrap);
    }

    /**
     * Builds the panel markup for a LIVE-hold state: applied summary +
     * Remove button. Styled via the same BS4 class constants renderApplyForm
     * uses above (see that block's comment).
     * @param {Object} state
     * @returns {void}
     * @param {Element} container
     */
    function renderAppliedState(state, container) {
        container.innerHTML = '';

        var wrap = document.createElement('div');
        wrap.className = PANEL_CLASS;

        var line = document.createElement('div');
        line.textContent = state.currentHold.holdPointsRedeemed + ' ' + (state.pointsName || 'points')
            + ' applied = ' + formatMoney(state.currentHold.holdAmount, state.currency) + ' off';
        line.className = PANEL_LINE_CLASS;
        wrap.appendChild(line);

        var removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.textContent = 'Remove';
        removeButton.className = REMOVE_BUTTON_CLASS;

        var messageLine = document.createElement('div');
        messageLine.className = MESSAGE_LINE_CLASS;

        removeButton.addEventListener('click', function () {
            removeButton.disabled = true;
            messageLine.textContent = '';

            // Same dynamically-keyed CSRF field pattern as renderApplyForm's
            // Apply handler above - see its comment for the full reasoning.
            // No { points: ... } base here since RedeemRemove takes no
            // points argument, only whichever CSRF field ends up present.
            var formParams = {};
            if (state.csrf && state.csrf.tokenName) {
                formParams[state.csrf.tokenName] = state.csrf.token;
            }

            postForm(redeemRemoveUrl, formParams, function (result) {
                if (result && result.success) {
                    reloadForFreshTotals();
                    return;
                }

                removeButton.disabled = false;
                messageLine.textContent = ERROR_COPY.try_again;
            }, function () {
                removeButton.disabled = false;
                messageLine.textContent = ERROR_COPY.try_again;
            });
        });

        wrap.appendChild(removeButton);
        wrap.appendChild(messageLine);
        container.appendChild(wrap);
    }

    /**
     * @param {Element} container
     * @returns {void}
     */
    function fetchAndRender(container) {
        getJson(redeemStateUrl, function (state) {
            if (!state || !state.enabled) {
                container.innerHTML = '';
                container.hidden = true;
                return;
            }

            container.hidden = false;

            if (state.currentHold) {
                renderAppliedState(state, container);
            } else {
                renderApplyForm(state, container);
            }
        }, function () {
            // Balance fetch failed - render nothing, exactly as a disabled
            // feature would. No console noise (H29's client-side form).
            container.innerHTML = '';
            container.hidden = true;
        });
    }

    var summaryContainer = findSummaryContainer();
    if (!summaryContainer) {
        // No known placement point on this theme - silently do not render,
        // rather than falling back to an oddly-placed footer panel.
        return;
    }

    var panel = document.createElement('div');
    panel.id = 'gameball-redeem-panel';
    panel.hidden = true;
    summaryContainer.parentNode.insertBefore(panel, summaryContainer);

    fetchAndRender(panel);
}());
