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

/**
 * money x (numerator / denominator), rounded to the currency's fraction
 * digits. Attempts dw.value.Money.multiply()/divide() first - build-plan
 * section 7.5 mandates refund arithmetic be Money-native - and falls back to
 * plain numeric arithmetic on toNumber(money) if either throws: Money can be
 * the NOT_AVAILABLE sentinel (throws on almost any operation), and whether
 * multiply()/divide() accept a fractional Number argument (rather than only
 * an int) and round internally is not confirmed on every SFCC version
 * (UNVERIFIED - no sandbox in this environment). Both paths round identically
 * at the end via roundToCurrency, so the fallback is invisible to every
 * caller - a refund's proration is never wrong by a currency's rounding rule,
 * only by which of two arithmetic engines computed it.
 * @param {dw.value.Money} money
 * @param {number} numerator
 * @param {number} denominator
 * @param {string} currencyCode
 * @returns {number} 0 when denominator is 0 or the amount is unavailable
 */
function prorateToNumber(money, numerator, denominator, currencyCode) {
    if (!denominator) {
        return 0;
    }

    try {
        var prorated = money.multiply(numerator).divide(denominator);
        var value = prorated.getValueOrNull();
        if (value !== null && value !== undefined) {
            return roundToCurrency(value, currencyCode);
        }
    } catch (e) {
        // Money-native path unavailable (NOT_AVAILABLE sentinel, or a
        // fractional multiply()/divide() overload this SFCC version does not
        // support) - fall through to the plain-number path below rather than
        // letting a refund amount computation throw.
    }

    return roundToCurrency(toNumber(money) * (numerator / denominator), currencyCode);
}

/**
 * a - b, rounded to the currency's fraction digits, clamped to >= 0. Never
 * returns a negative "refund" - a caller subtracting an already-refunded
 * amount from a tracked total that arithmetic drift has pushed past it gets
 * 0, not a negative number that would then have to be defended against
 * separately at every call site.
 * @param {number} a
 * @param {number} b
 * @param {string} currencyCode
 * @returns {number}
 */
function subtractToNumber(a, b, currencyCode) {
    var left = typeof a === 'number' && !isNaN(a) ? a : 0;
    var right = typeof b === 'number' && !isNaN(b) ? b : 0;
    return roundToCurrency(clampNonNegative(left - right), currencyCode);
}

module.exports = {
    toNumber: toNumber,
    clampNonNegative: clampNonNegative,
    roundToCurrency: roundToCurrency,
    prorateToNumber: prorateToNumber,
    subtractToNumber: subtractToNumber
};
