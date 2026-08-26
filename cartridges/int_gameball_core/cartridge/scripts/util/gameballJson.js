'use strict';

/**
 * Serialises a value to JSON text hardened for embedding in an HTML document.
 *
 * Escapes <, >, & and U+2028/U+2029 to their \uXXXX forms. Every one of these
 * is a legal escape in BOTH JSON and JavaScript string literals, so JSON.parse
 * returns a string identical to the input - characters are escaped, never
 * deleted (build-plan section 4.7: deleting them silently corrupts merchant
 * data, e.g. a legitimate surname containing "&").
 *
 * CRITICAL: this is DEFENCE IN DEPTH, not the security boundary. The output is
 * placed in a double-quoted HTML attribute, and the platform's own attribute
 * encoder is what actually prevents breakout - it is the only thing that can
 * neutralise the " characters JSON.stringify itself emits as delimiters. Do
 * not conclude from this function's existence that encoding=off is ever safe
 * here: the rejected alternative was a <script type="application/json"> data
 * block plus encoding=off on this output (build-plan section 4.7), which
 * makes this five-replace chain load-bearing. That construct has already
 * regressed twice in widget.isml (d0edac1 -> 987e1ca -> ed864a2), so the
 * attribute form was chosen precisely so that no hand-rolled escaper stands
 * between a customer's name and script execution.
 *
 * That the platform encodes an interpolated expression inside a double-quoted
 * attribute is UNVERIFIED against a live instance - there is no sandbox here.
 * Arbitration risk R-5 makes it the merge gate for this item, because the
 * escapes below stop short of the double quote on purpose: if the encoder
 * turns out to be a forHtmlContent-style encoder that touches only &, < and >,
 * the JSON delimiters reach the attribute raw and this function's output is no
 * longer safe there. The check and the one-token fallback are written out in
 * the iscomment at the top of templates/default/gameball/widget.isml; do not
 * reuse this function in a new context without settling R-5 first.
 *
 * @param {Object|Array|string|number|boolean} value - must be JSON-serialisable
 * @returns {string} JSON text, or '' when the value serialises to undefined
 * @throws {TypeError} if the value contains a circular reference (a programming
 *   error; the caller's boundary catch suppresses the widget)
 */
function toEmbeddableJson(value) {
    var json = JSON.stringify(value);

    // JSON.stringify returns the undefined VALUE (not the string "undefined")
    // for undefined, a function or a symbol. Returning '' lets the caller treat
    // "nothing to embed" as one falsy check rather than two.
    if (json === undefined || json === null) {
        return '';
    }

    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

module.exports = {
    toEmbeddableJson: toEmbeddableJson
};
