'use strict';

var MessageDigest = require('dw/crypto/MessageDigest');
var Encoding = require('dw/crypto/Encoding');
var Bytes = require('dw/util/Bytes');

// UTF-8 is named explicitly rather than left to the platform default: the
// digest of a name carrying a non-ASCII character must not change because an
// instance's default charset differs from a sandbox's, which would silently
// re-POST every accented shopper on the first run after a platform change.
var CHARSET = 'UTF-8';

/**
 * Lower-case hex SHA-256 of a string.
 *
 * digestBytes() + Encoding.toHex() rather than the one-argument
 * MessageDigest#digest(String): digest(String)'s output encoding (hex vs
 * Base64) is undocumented in the vendored dw-api-mock and unverifiable
 * without a sandbox, whereas this exact three-call form is shipped in
 * production by the Yotpo LINK cartridge
 * (int_yotpo_sfra/cartridge/models/common/commonModel.js:52-60), so the
 * output shape is known rather than assumed.
 *
 * .toLowerCase() is not cosmetic. Encoding.toHex's letter case is nowhere
 * documented, and a stored hash is compared against a freshly computed one
 * across releases and across instances - a platform that ever switched case
 * would invalidate every stored hash at once and trigger a full re-POST wave.
 * Normalising both sides removes that possibility entirely.
 *
 * @param {string} text
 * @returns {string} 64 lower-case hex characters, or '' on any failure.
 *          '' is a deliberate sentinel: it never equals a stored hash, so a
 *          broken digest degrades to "always send" (costing quota) rather
 *          than to "never send" (costing the feature, silently).
 */
function sha256Hex(text) {
    try {
        var digest = new MessageDigest(MessageDigest.DIGEST_SHA_256);
        return String(Encoding.toHex(digest.digestBytes(new Bytes(text, CHARSET)))).toLowerCase();
    } catch (e) {
        // Swallowed without a log on purpose: this is called once per profile
        // on a 20,000-profile sweep, so a platform-level digest failure would
        // otherwise write 20,000 identical error lines. The caller
        // (gameballPayloadHash.of) turns '' into "always send", which is the
        // visible symptom, and the resulting API traffic is the alarm.
        return '';
    }
}

module.exports = {
    sha256Hex: sha256Hex
};
