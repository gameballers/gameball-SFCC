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
     * SFCC's CSRF cookie, read for inclusion as a form field on every
     * POST - csrfProtection.validateAjaxRequest checks the submitted
     * csrf_token value against this same cookie. UNVERIFIED exact cookie
     * name against a live instance in this environment; 'csrf_token' is the
     * documented default.
     * @returns {string}
     */
    function readCsrfToken() {
        var match = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
        return match ? decodeURIComponent(match[1]) : '';
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

    function formatMoney(amount, currency) {
        var value = (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2);
        return currency ? (value + ' ' + currency) : value;
    }

    /**
     * Builds the panel markup for a NO-live-hold state: balance line,
     * slider, Apply button. Plain inline styles - no SCSS/CSS pipeline
     * exists anywhere in this cartridge to hang a class-based stylesheet
     * off, and adding one from scratch for a single small panel is out of
     * proportion to what this feature needs.
     * @param {Object} state - a Gameball-RedeemState response
     * @param {Element} container
     * @returns {void}
     */
    function renderApplyForm(state, container) {
        container.innerHTML = '';

        var wrap = document.createElement('div');
        wrap.style.cssText = 'border:1px solid #ddd;border-radius:4px;padding:12px;margin:12px 0;font-size:14px;';

        var balanceLine = document.createElement('div');
        balanceLine.textContent = 'You have ' + state.availablePointsBalance + ' '
            + (state.pointsName || 'points') + ' = ' + formatMoney(state.availablePointsValue, state.currency) + ' available';
        balanceLine.style.cssText = 'margin-bottom:8px;';
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
        slider.style.cssText = 'width:100%;';

        var selectedLine = document.createElement('div');
        selectedLine.style.cssText = 'margin:8px 0;';

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
        applyButton.style.cssText = 'padding:6px 14px;';

        var messageLine = document.createElement('div');
        messageLine.style.cssText = 'color:#b00020;margin-top:6px;';

        applyButton.addEventListener('click', function () {
            var points = parseInt(slider.value, 10) || 0;
            if (points <= 0) {
                return;
            }

            applyButton.disabled = true;
            messageLine.textContent = '';

            postForm(redeemUrl, { points: points, csrf_token: readCsrfToken() }, function (result) {
                applyButton.disabled = false;
                if (result && result.success) {
                    fetchAndRender(container);
                } else {
                    messageLine.textContent = (result && ERROR_COPY[result.error]) || ERROR_COPY.try_again;
                }
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
     * Remove button.
     * @param {Object} state
     * @returns {void}
     * @param {Element} container
     */
    function renderAppliedState(state, container) {
        container.innerHTML = '';

        var wrap = document.createElement('div');
        wrap.style.cssText = 'border:1px solid #ddd;border-radius:4px;padding:12px;margin:12px 0;font-size:14px;';

        var line = document.createElement('div');
        line.textContent = state.currentHold.holdPointsRedeemed + ' ' + (state.pointsName || 'points')
            + ' applied = ' + formatMoney(state.currentHold.holdAmount, state.currency) + ' off';
        line.style.cssText = 'margin-bottom:8px;';
        wrap.appendChild(line);

        var removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.textContent = 'Remove';
        removeButton.style.cssText = 'padding:6px 14px;';

        var messageLine = document.createElement('div');
        messageLine.style.cssText = 'color:#b00020;margin-top:6px;';

        removeButton.addEventListener('click', function () {
            removeButton.disabled = true;
            messageLine.textContent = '';

            postForm(redeemRemoveUrl, { csrf_token: readCsrfToken() }, function (result) {
                removeButton.disabled = false;
                if (result && result.success) {
                    fetchAndRender(container);
                } else {
                    messageLine.textContent = ERROR_COPY.try_again;
                }
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
