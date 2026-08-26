'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.customer');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
var customerPayload = require('*/cartridge/models/payload/customerPayload');
var gameballService = require('*/cartridge/scripts/services/gameballService');

// Request-scoped memo key. Not persistent state, and deliberately not a
// Custom Object - see wasSentThisRequest().
var REQUEST_MEMO_KEY = 'gbCustomerUpsertKey';

// Gameball codes that mean "this might succeed later", plus SFCC's own
// transport status for a timeout or an open circuit breaker, which arrives
// with no Gameball envelope at all (build-plan section 13.8). There is no
// queue and no retry in this iteration, so "transient" changes exactly one
// thing - warn instead of error, i.e. whether an operator is paged - and
// never the behaviour. Anything not listed here is treated as permanent and
// logged at error rather than guessed at.
//
// The list deliberately mixes two vocabularies, because describeFailure()
// resolves a code down a ladder and any rung can produce the answer: Gameball
// envelope codes (2001/5000/5003), the bare HTTP statuses rung 2 yields when
// the body is not the documented envelope (429, and the 500/503 twins of 5000
// and 5003 - Gameball's edge can return an HTML 503 during an outage, which
// would otherwise be classified permanent and page someone), and SFCC's own
// transport status from rung 3.
// 422 is deliberately absent: the transient 2001 shares it with the permanent
// 3003 / 3008 / 7001, so a bare 422 cannot be classified either way.
// UNVERIFIED (no sandbox in this environment): the exact spelling of the SFCC
// transport status read off dw.svc.Result#status. If it differs, the only
// consequence is that a timeout logs at error instead of warn.
var TRANSIENT_CODES = ['2001', '5000', '5003', '429', '500', '503', 'SERVICE_UNAVAILABLE'];

// Gameball's "customer already exists". The endpoint is an idempotent upsert
// keyed on customerId (build-plan section 13.4) so this should never surface;
// if it does, the profile is already on Gameball's side and re-sending cannot
// help. Warn rather than error - there is nothing for an operator to fix.
var CODE_CUSTOMER_EXISTS = '7001';

/**
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * Reads one boolean site preference, defaulting rather than failing.
 *
 * Guarded for the same reason getRequestId() is: a log-level gate must never
 * be the thing that breaks a customer sync. Site.getCurrent() returns null in
 * a context with no site, so that is handled too.
 *
 * "Not imported yet" and "the operator set it to No" are deliberately NOT the
 * same answer, which is the whole reason this is not a one-line !! coercion.
 *
 * @param {string} id - the site-preference id
 * @param {boolean} fallback - the value to use when the preference has no
 *        stored value at all, or cannot be read
 * @returns {boolean}
 */
function readBooleanPreference(id, fallback) {
    try {
        var site = Site.getCurrent();
        if (!site) {
            return fallback;
        }

        var value = site.getCustomPreferenceValue(id);

        // getCustomPreferenceValue returns null for an id that has not been
        // imported - it does not throw. That is the same platform behaviour
        // Gameball.js records as the defect which left the widget dead, and it
        // is the normal state during a code-then-metadata release, on a second
        // site the import did not target, or after a partial import. Coercing
        // straight to boolean would answer false there, so the fallback below
        // would be reachable only through the catch and the documented "info
        // logging defaults to on" promise would silently never hold - taking
        // every success line, every skip line and the double-dispatch alarm
        // with it. The <default-value> in the metadata is then belt-and-braces
        // rather than the only thing standing between us and a silent log.
        if (value === null || value === undefined) {
            return fallback;
        }

        return !!value;
    } catch (e) {
        return fallback;
    }
}

/**
 * @returns {boolean} true when info/warn lines should be written. Defaults to
 * true when the preference cannot be read: the INFO line is the only proof
 * that exactly one upsert left per request, and losing that silently is worse
 * than one unwanted log line.
 */
function isInfoLogEnabled() {
    return readBooleanPreference('gameballInfoLogEnabled', true);
}

/**
 * @returns {boolean} true when the low-value debug skip lines should be
 * written. Defaults to false: these fire on every profile save of a site that
 * has Gameball switched off.
 */
function isDebugLogEnabled() {
    return readBooleanPreference('gameballDebugLogEnabled', false);
}

/**
 * The SFCC per-request correlation token, used to prove that exactly one
 * upsert leaves per registration and per profile save.
 *
 * Returns '' outside an HTTP request (job, OCAPI and Data-API contexts) and on
 * any failure. That empty string is load-bearing twice over: a log correlator
 * must never be the thing that breaks the call, and it is also what makes the
 * per-request memo inert in a job - see wasSentThisRequest().
 *
 * @returns {string}
 */
function getRequestId() {
    try {
        if (!request || typeof request.isHttpRequest !== 'function' || !request.isHttpRequest()) {
            return '';
        }

        return request.getRequestID() || '';
    } catch (e) {
        return '';
    }
}

/**
 * "Have we already upserted this customerId inside this HTTP request?"
 *
 * Deliberately separate from isGameballEnabled(), which answers "should we
 * ever upsert at all" - the same split orderSyncGate.js:45-48 documents for
 * orders. This is belt-and-braces on top of the real fix (exactly one dispatch
 * path per route): it turns a future second call site from a silent extra POST
 * into a countable WARN line.
 *
 * One slot, holding the composite "<sfccRequestId>|<customerId>". A request
 * that upserted two different customers would therefore only remember the
 * second - no storefront route produces that shape, and the cost if one ever
 * does is one extra idempotent POST, which is the direction this guard is
 * allowed to fail in. A growing key list was rejected: it would need a bound,
 * and the bound would become the thing that broke.
 *
 * Inert outside an HTTP request (sfccRequestId is '') so a future job sweeping
 * many distinct customers is never suppressed, and inert if request.custom
 * cannot be read, because a missing guard must degrade to sending rather than
 * to not sending.
 *
 * UNVERIFIED (no sandbox in this environment): that a plain assignment to
 * request.custom survives within one request. The documented fallback is the
 * same composite string in session.privacy - which is why both helpers take
 * sfccRequestId even though request.custom alone would not need it.
 *
 * @param {string} sfccRequestId
 * @param {string} customerId
 * @returns {boolean}
 */
function wasSentThisRequest(sfccRequestId, customerId) {
    if (!sfccRequestId || !customerId) {
        return false;
    }

    try {
        return request.custom[REQUEST_MEMO_KEY] === sfccRequestId + '|' + customerId;
    } catch (e) {
        // A memo that cannot be read means "not sent yet", so the caller sends.
        return false;
    }
}

/**
 * Records that customerId was upserted in this request. Called BEFORE the
 * outbound call, not after, so a throw inside the service call still blocks a
 * second attempt in the same request. request.custom is request-scoped and
 * non-persistent, so this needs no Transaction (rule P1 does not apply).
 * @param {string} sfccRequestId
 * @param {string} customerId
 */
function markSentThisRequest(sfccRequestId, customerId) {
    if (!sfccRequestId || !customerId) {
        return;
    }

    try {
        request.custom[REQUEST_MEMO_KEY] = sfccRequestId + '|' + customerId;
    } catch (e) {
        // Swallowed on purpose: failing to record the memo costs the
        // regression alarm for a double dispatch, never the upsert itself.
    }
}

/**
 * Pulls Gameball's error envelope out of a failed dw.svc.Result.
 *
 * SFCC surfaces a non-2xx as result.errorMessage carrying the raw response
 * body, so the envelope has to be parsed back out rather than read off a typed
 * field - parseResponse does not run on the failure path. The code is resolved
 * down a ladder: Gameball's own envelope code first (the only value that says
 * WHY), then the HTTP status, then SFCC's transport status for a call that
 * never reached Gameball at all. The raw body survives as the message when it
 * is not the documented JSON envelope (build-plan section 13.8).
 *
 * UNVERIFIED (no sandbox in this environment): that errorMessage carries the
 * raw non-2xx body at all. Everything here is written so that an unexpected
 * shape degrades to "unknown code, raw text message" - never to a thrown
 * exception and never to a failure being read as a success.
 *
 * @param {dw.svc.Result} result
 * @returns {{code: string, requestId: string, message: string}}
 */
function describeFailure(result) {
    var failure = { code: '', requestId: '', message: '' };

    try {
        failure.message = String(result.errorMessage || '');
    } catch (e) {
        failure.message = '';
    }

    try {
        var envelope = failure.message ? JSON.parse(failure.message) : null;
        if (envelope && typeof envelope === 'object') {
            if (envelope.code !== undefined && envelope.code !== null) {
                failure.code = String(envelope.code);
            }
            if (envelope.requestId) {
                failure.requestId = String(envelope.requestId);
            }
            if (envelope.message) {
                failure.message = String(envelope.message);
            }
        }
    } catch (e) {
        // Not the documented JSON envelope - keep the raw body as the message
        // and let the ladder below fill in what code it can. A body that will
        // not parse is never a reason to report no failure detail at all.
    }

    if (!failure.code) {
        try {
            failure.code = result.error ? String(result.error) : '';
        } catch (e) {
            failure.code = '';
        }
    }

    if (!failure.code) {
        try {
            failure.code = String(result.status || '');
        } catch (e) {
            failure.code = '';
        }
    }

    if (!failure.message) {
        failure.message = 'no error message';
    }

    return failure;
}

/**
 * @param {string} code - Gameball error code as a string, or '' when unknown
 * @returns {boolean} true for codes that mean "try again later", false for
 *          codes that mean "this request will never succeed as sent"
 */
function isTransientFailure(code) {
    if (!code) {
        return false;
    }

    for (var i = 0; i < TRANSIENT_CODES.length; i++) {
        if (TRANSIENT_CODES[i] === code) {
            return true;
        }
    }

    return false;
}

/**
 * Reads gameballId off a 200 response. The 200 body is documented as
 * { "gameballId": number } and nothing else (build-plan section 13.4), but
 * gameballService.parseResponse falls back to raw text on unparseable JSON, so
 * the object shape is checked rather than assumed.
 * @param {dw.svc.Result} result
 * @returns {string} the id, or '' when absent/unparseable
 */
function readGameballId(result) {
    try {
        var body = result.getObject();
        if (body && typeof body === 'object' && body.gameballId !== undefined && body.gameballId !== null) {
            return String(body.gameballId);
        }
    } catch (e) {
        return '';
    }

    return '';
}

/**
 * Writes the one anomalous-skip line.
 *
 * Factored out because three separate guards emit it and the exact string is
 * contractual - the acceptance procedure greps for it verbatim, so three
 * hand-copied duplicates would be three chances to let one drift.
 *
 * @param {boolean} infoOn - the memoised gameballInfoLogEnabled read
 * @param {string} source - the SFCC trigger, e.g. ACCOUNT_SAVE_PROFILE
 * @param {string} reason - no_profile | no_customer_id | already_sent_this_request
 * @param {string} customerId - '' when the id is the thing that was missing
 * @param {string} sfccRequestId
 */
function logSkipped(infoOn, source, reason, customerId, sfccRequestId) {
    if (!infoOn) {
        return;
    }

    Logger.warn('gameballCustomerApi~sendCustomer upsert skipped (source={0}, reason={1}, customerId={2}, sfccRequestId={3})',
        source, reason, customerId || 'unknown', sfccRequestId);
}

/**
 * Upserts one SFCC customer to Gameball's idempotent
 * POST integrations/customers endpoint (build-plan section 13.4).
 *
 * Never throws: every failure path is logged and swallowed so a Gameball
 * outage can never break a storefront form POST.
 *
 * At most ONE upsert is sent per SFCC HTTP request per customerId - the
 * per-request memo in wasSentThisRequest() enforces that, and logs a WARN
 * naming the source if anything tries to send a second one. That guard is
 * belt-and-braces on top of the real fix (exactly one dispatch path per
 * route); it exists so a future second call site cannot silently double-post
 * the way a stray hook dispatch could have.
 *
 * @param {dw.customer.Customer} customer - the SFCC customer; its .profile is
 *        read, so an anonymous customer is skipped with a WARN
 * @param {string} source - the SFCC trigger that produced this sync, e.g.
 *        'ACCOUNT_SUBMIT_REGISTRATION' or 'ACCOUNT_SAVE_PROFILE'. Logged
 *        verbatim as the correlator; never sent to Gameball.
 * @returns {boolean} true only when an upsert was actually POSTed and
 *          Gameball returned OK; false for every guard, skip and failure
 */
function sendCustomer(customer, source) {
    try {
        // Both gates are read once per call and reused by every line below,
        // rather than re-reading the site preference inside each log call
        // (H28). This function can log twice, and a preference read is not
        // free enough to spend on a line that may never be written.
        var infoOn = isInfoLogEnabled();
        var debugOn = isDebugLogEnabled();
        var sfccRequestId = getRequestId();

        if (!isGameballEnabled()) {
            // debug, not info: on a site with Gameball switched off this would
            // otherwise fire on every profile save, which is a non-event.
            if (debugOn) {
                Logger.debug('gameballCustomerApi~sendCustomer upsert skipped (source={0}, reason=integration_disabled, sfccRequestId={1})',
                    source, sfccRequestId);
            }
            return false;
        }

        var profile = customer && customer.profile;
        if (!profile) {
            // Promoted from a silent return. The registration path used to
            // land here whenever customer resolution fell back to the
            // anonymous customer, leaving no evidence at all that a sync had
            // been dropped.
            logSkipped(infoOn, source, 'no_profile', '', sfccRequestId);
            return false;
        }

        var payload = customerPayload.build(profile);
        var customerId = payload && payload.customerId;
        if (!customerId) {
            // customerId is Required: Yes and is the upsert's idempotent key.
            // Sending without it earns a guaranteed 3000/3001 and spends one
            // of the 360-per-30s customer-POST budget to do it.
            logSkipped(infoOn, source, 'no_customer_id', '', sfccRequestId);
            return false;
        }

        if (wasSentThisRequest(sfccRequestId, customerId)) {
            // The regression alarm for the exact class of bug this module was
            // refactored to remove: a second dispatch path in one request.
            logSkipped(infoOn, source, 'already_sent_this_request', customerId, sfccRequestId);
            return false;
        }

        // Marked BEFORE the call, not after, so an exception inside the
        // service call still blocks a second attempt in the same request.
        markSentThisRequest(sfccRequestId, customerId);

        var result = gameballService.call({
            path: 'integrations/customers',
            body: payload
        });

        if (!result.isOk()) {
            var failure = describeFailure(result);

            if (failure.code === CODE_CUSTOMER_EXISTS) {
                if (infoOn) {
                    Logger.warn('gameballCustomerApi~sendCustomer upsert not applied, customer already exists (source={0}, customerId={1}, sfccRequestId={2}, code={3}, gbRequestId={4}): {5}',
                        source, customerId, sfccRequestId, failure.code, failure.requestId, failure.message);
                }
            } else if (isTransientFailure(failure.code)) {
                if (infoOn) {
                    Logger.warn('gameballCustomerApi~sendCustomer upsert failed, transient (source={0}, customerId={1}, sfccRequestId={2}, code={3}, gbRequestId={4}): {5}',
                        source, customerId, sfccRequestId, failure.code, failure.requestId, failure.message);
                }
            } else {
                Logger.error('gameballCustomerApi~sendCustomer upsert failed (source={0}, customerId={1}, sfccRequestId={2}, code={3}, gbRequestId={4}): {5}',
                    source, customerId, sfccRequestId, failure.code, failure.requestId, failure.message);
            }

            return false;
        }

        // A 200 whose body is not the documented { gameballId } object still
        // succeeded - gameballService.parseResponse falls back to raw text, so
        // gameballId simply prints empty. A response shape is never a reason
        // to downgrade a 200 to a failure.
        var gameballId = readGameballId(result);
        if (infoOn) {
            Logger.info('gameballCustomerApi~sendCustomer upsert sent (source={0}, customerId={1}, gameballId={2}, sfccRequestId={3})',
                source, customerId, gameballId, sfccRequestId);
        }

        return true;
    } catch (e) {
        // Never gated (H28). getRequestId() is re-read rather than referenced
        // because the throw may have come from the gate reads above, before
        // sfccRequestId was ever assigned - and this line is the whole reason
        // an undefined-preference read is now visible instead of being
        // swallowed message-less the way this function used to end.
        Logger.error('gameballCustomerApi~sendCustomer exception (source={0}, sfccRequestId={1}): {2}',
            source, getRequestId(), e && e.message);
        return false;
    }
}

module.exports = {
    sendCustomer: sendCustomer
};
