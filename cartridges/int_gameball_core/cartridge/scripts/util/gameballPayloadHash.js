'use strict';

var gameballHash = require('*/cartridge/scripts/util/gameballHash');

// Bumping this is the deliberate lever that forces a one-time resync of every
// profile: no stored hash can match a new prefix, so every profile inside the
// delta job's lookback window re-POSTs exactly once and then settles. The cost
// is bounded by the lookback window, never by the size of the customer base -
// which is why the version lives in the hash rather than in a "resync all"
// flag someone would have to remember to clear.
//
// Raise it whenever customerPayload.build() changes shape. Not raising it is
// the failure that matters: stored hashes would then be hashes of a payload
// that is no longer sent, and the changed field would never reach Gameball.
var HASH_VERSION = 'v1';

// A cyclic or pathologically nested object must not hang a job step. 16 is the
// same depth cap the standards set for the log scrubber (S15); the payload
// customerPayload.build() produces is 2 deep, so this can only ever fire on a
// future builder that went badly wrong.
var MAX_DEPTH = 16;

/**
 * Serialises a JSON-ready value to a string whose bytes depend only on the
 * value, never on property insertion order.
 *
 * JSON.stringify is NOT usable here. ES5 does not guarantee object key order,
 * and customerPayload.build() sets customerAttributes.dateOfBirth
 * conditionally, so the same profile can legitimately produce two different
 * stringify outputs on two runs. Every one of those differences would read as
 * "the profile changed" and re-POST it, which defeats the only mechanism
 * stopping the hourly sweep from re-sending the entire customer base.
 *
 * Rules, chosen so the string is unambiguous rather than merely stable:
 *  - object: keys sorted, each rendered as JSON.stringify(key) + ':' + value,
 *    so a key containing ':' or ',' cannot forge a boundary
 *  - array: elements in order, order being meaningful in an array
 *  - null/undefined property values: the property is omitted, matching what
 *    JSON.stringify actually sends to Gameball (customerPayload.js:15 relies
 *    on exactly this for the optional top-level email)
 *  - null/undefined array elements: rendered as null, because JSON.stringify
 *    sends them as null rather than collapsing the array
 *  - string: JSON.stringify, for its deterministic escaping - and '' is KEPT,
 *    not dropped, because customerPayload sends firstName: profile.firstName
 *    || '' and "the shopper cleared their first name" is a real change
 *  - Date: ISO-8601, so a Date and its string form can never collide
 *
 * @param {*} value
 * @param {number} depth - current recursion depth; callers pass 0
 * @returns {string}
 */
function canonicalize(value, depth) {
    if (depth > MAX_DEPTH) {
        return '"__depth__"';
    }

    if (value === null || value === undefined) {
        return 'null';
    }

    var type = typeof value;

    if (type === 'string') {
        return JSON.stringify(value);
    }

    if (type === 'number') {
        // String(n) rather than JSON.stringify(n) so NaN and Infinity - which
        // JSON.stringify silently turns into null - stay distinguishable from
        // a genuine null. Neither can appear in today's payload; both would
        // otherwise become invisible in a future one.
        return String(value);
    }

    if (type === 'boolean') {
        return value ? 'true' : 'false';
    }

    if (typeof value.getTime === 'function') {
        try {
            return JSON.stringify(value.toISOString());
        } catch (e) {
            // Not a Date after all, or an invalid one. Fall through to the
            // object branch rather than guessing at a representation.
        }
    }

    if (Object.prototype.toString.call(value) === '[object Array]') {
        var elements = [];
        for (var i = 0; i < value.length; i++) {
            elements.push(canonicalize(value[i], depth + 1));
        }
        return '[' + elements.join(',') + ']';
    }

    if (type === 'object') {
        var keys = Object.keys(value).sort();
        var parts = [];
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            var propertyValue = value[key];

            // Omitted, not rendered as null: this is what JSON.stringify does
            // to an undefined property, so the hash describes the bytes that
            // actually go on the wire.
            if (propertyValue === null || propertyValue === undefined) {
                continue;
            }

            parts.push(JSON.stringify(key) + ':' + canonicalize(propertyValue, depth + 1));
        }
        return '{' + parts.join(',') + '}';
    }

    // A function or some other non-JSON value. Nothing sane can be hashed from
    // it, so name the type rather than allowing String() to emit source code.
    return JSON.stringify('__' + type + '__');
}

/**
 * Versioned, key-order-independent hash of a payload body.
 *
 * This is the whole of the change-detection mechanism: a sync path that
 * recomputes this and finds it equal to Profile.custom.gbSyncHash makes no API
 * call at all. Without it the hourly delta sweep would re-POST every profile
 * modified inside its lookback window on every single run.
 *
 * @param {Object} payload - the object customerPayload.build() returned
 * @returns {string} 'v1:<64 hex chars>', or '' when a digest could not be
 *          computed. '' never equals a stored hash, so a hashing failure
 *          degrades to "always send" - it costs Gameball quota, never the
 *          feature. Returning a constant placeholder was rejected for the
 *          opposite reason: it would match itself and silently stop syncing.
 */
function of(payload) {
    try {
        var digest = gameballHash.sha256Hex(canonicalize(payload, 0));
        if (!digest) {
            return '';
        }

        return HASH_VERSION + ':' + digest;
    } catch (e) {
        return '';
    }
}

module.exports = {
    of: of
};
