'use strict';

var Currency = require('dw/util/Currency');

var DEFAULT_FRACTION_DIGITS = 2;

/**
 * Safely reads a dw.value.Money amount as a plain JS number, never throwing.
 * dw.value.Money can be the NOT_AVAILABLE sentinel (bonus products, unpriced
 * options, imported orders with no tax calculated) - calling .getValue() on
 * that throws. This uses .getValueOrNull() instead (returns null rather than
 * throwing when the amount is N/A), guarded with its own try/catch in case
 * `money` isn't a real Money instance at all.
 * @param {dw.value.Money} money - possibly null/undefined/NOT_AVAILABLE
 * @returns {number} the numeric amount, or 0 if unavailable
 */
function toNumber(money) {
    if (!money) {
        return 0;
    }

    try {
        var value = money.getValueOrNull();
        return value === null || value === undefined ? 0 : value;
    } catch (e) {
        return 0;
    }
}

/**
 * Clamps a number to be >= 0. Never returns NaN - a non-numeric input
 * is treated as 0.
 * @param {number} value
 * @returns {number}
 */
function clampNonNegative(value) {
    var num = typeof value === 'number' && !isNaN(value) ? value : 0;
    return num < 0 ? 0 : num;
}

/**
 * Rounds a number to the given currency's default fraction digits
 * (e.g. 2 for USD/EUR, 0 for JPY). Falls back to 2 digits if the currency
 * code doesn't resolve to a real dw.util.Currency.
 * @param {number} value
 * @param {string} currencyCode - ISO 4217 currency code, e.g. order.getCurrencyCode()
 * @returns {number}
 */
function roundToCurrency(value, currencyCode) {
    var num = typeof value === 'number' && !isNaN(value) ? value : 0;
    var digits = DEFAULT_FRACTION_DIGITS;

    try {
        var currency = currencyCode ? Currency.getCurrency(currencyCode) : null;
        if (currency !== null && currency !== undefined) {
            digits = currency.getDefaultFractionDigits();
        }
    } catch (e) {
        digits = DEFAULT_FRACTION_DIGITS;
    }

    var factor = Math.pow(10, digits);
    return Math.round(num * factor) / factor;
}

module.exports = {
    toNumber: toNumber,
    clampNonNegative: clampNonNegative,
    roundToCurrency: roundToCurrency
};
