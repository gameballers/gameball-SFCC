'use strict';

var Site = require('dw/system/Site');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.customer');
var customerPayload = require('*/cartridge/models/payload/customerPayload');
var customerSyncGate = require('*/cartridge/scripts/customer/customerSyncGate');
var gameballErrors = require('*/cartridge/scripts/util/gameballErrors');
var gameballPayloadHash = require('*/cartridge/scripts/util/gameballPayloadHash');
var gameballService = require('*/cartridge/scripts/services/gameballService');

// Request-scoped memo key. Not persistent state, and deliberately not a
// Custom Object - see wasSentThisRequest().
var REQUEST_MEMO_KEY = 'gbCustomerUpsertKey';

// Values written to Profile.custom.gbSyncState. UPPERCASE with the set spelled
// out in the metadata description (H39) so a merchant can read the state
// machine off the Business Manager customer screen, which is the only operator
// surface this iteration ships.
// The third value, SKIPPED, is deliberately NOT declared here: it is minted by
// customerSyncGate, which is the module that decides a profile should be
// skipped, and is written through from gate.skipState. A second copy of the
// literal in this file would be a second place for the value to drift from the
// one the metadata description enumerates.
var SYNC_STATE_SYNCED = 'SYNCED';
var SYNC_STATE_FAILED = 'FAILED';

// Returned, never persisted: it names the case where the payload hash matched
// and no call was made, which is not an outcome of a call and therefore has no
// business being written onto the profile. Writing it would also bump
// lastModified on every unchanged profile the delta sweep touches, which is
// precisely the feedback loop the hash exists to prevent.
var SYNC_STATE_UNCHANGED = 'UNCHANGED';

// gbLastSyncError budget. The message is the only free-text part, so it is cut
// first and the whole line is cut again as a backstop. Neither bound is
// arbitrary: the composed line must fit a string custom attribute with room to
// spare, and the four fields that matter to Gameball support (status, code,
// requestId) must never be the part that gets truncated away.
var ERROR_MESSAGE_MAX = 200;
var ERROR_LINE_MAX = 500;

// The local isGameballEnabled() that used to live here has been RELOCATED, not
// deleted: it is now customerSyncGate.isEnabled(), reached through
// customerSyncGate.evaluate() below. It moved because five entry points now
// need the same predicate and a private copy per module is how the
// Gameball_Enabled / gameballEnabled alias defect happened in the first place.

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
 * Deliberately separate from customerSyncGate.isEnabled(), which answers
 * "should we ever upsert at all" - the same split orderSyncGate.js:45-48
 * documents for orders. This is belt-and-braces on top of the real fix
 * (exactly one dispatch path per route): it turns a future second call site
 * from a silent extra POST into a countable WARN line.
 *
 * One slot, holding the composite "<sfccRequestId>|<customerId>". A request
 * that upserted two different customers would therefore only remember the
 * second - no storefront route produces that shape, and the cost if one ever
 * does is one extra idempotent POST, which is the direction this guard is
 * allowed to fail in. A growing key list was rejected: it would need a bound,
 * and the bound would become the thing that broke.
 *
 * Inert outside an HTTP request (sfccRequestId is '') so the delta job sweeping
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
 * Null/exception-safe read of one Gameball custom attribute off a profile.
 *
 * Reads through custom.* rather than a typed getter because these attributes
 * only exist once the Gameball metadata has been imported. On an instance where
 * it has not, the read returns undefined rather than throwing - and undefined
 * never equals a computed hash, so the profile is simply always sent. That is
 * the correct degradation: a missing metadata import costs quota, not sync.
 *
 * @param {dw.customer.Profile} profile
 * @param {string} name - the gb* attribute id
 * @returns {string} '' when absent or unreadable
 */
function readCustomAttr(profile, name) {
    try {
        var value = profile && profile.custom && profile.custom[name];
        return value === null || value === undefined ? '' : String(value);
    } catch (e) {
        return '';
    }
}

/**
 * Null/exception-safe read of a profile's customer number, for log lines and
 * the upsert key.
 * @param {dw.customer.Profile} profile
 * @returns {string} '' when the profile or the number is absent
 */
function readCustomerNo(profile) {
    try {
        return (profile && profile.customerNo) || '';
    } catch (e) {
        return '';
    }
}

/**
 * Writes any subset of the six Gameball profile attributes in ONE transaction.
 *
 * A key set to null clears the attribute; a key that is undefined is not
 * written at all. That distinction is what lets one helper serve both "record
 * this success and clear the stale error" and "record this failure and leave
 * the last accepted hash exactly where it is".
 *
 * The whole write is caught and logged rather than propagated (H20): if the
 * Profile type-extension has not been imported, every one of these assignments
 * throws, and a failure to record state must never take down the storefront
 * request or truncate a 20,000-profile sweep. The log line names the fix
 * because that is the only symptom a merchant will ever see.
 *
 * @param {dw.customer.Profile} profile
 * @param {Object} attrs
 */
function persistSyncState(profile, attrs) {
    try {
        Transaction.wrap(function () {
            if (attrs.gbSyncState !== undefined) {
                profile.custom.gbSyncState = attrs.gbSyncState;
            }
            if (attrs.gbSyncHash !== undefined) {
                profile.custom.gbSyncHash = attrs.gbSyncHash;
            }
            if (attrs.gbLastSyncAt !== undefined) {
                profile.custom.gbLastSyncAt = attrs.gbLastSyncAt;
            }
            if (attrs.gbGameballId !== undefined) {
                profile.custom.gbGameballId = attrs.gbGameballId;
            }
            if (attrs.gbSyncSource !== undefined) {
                profile.custom.gbSyncSource = attrs.gbSyncSource;
            }
            if (attrs.gbLastSyncError !== undefined) {
                profile.custom.gbLastSyncError = attrs.gbLastSyncError;
            }
        });
    } catch (e) {
        Logger.error('Gameball customer sync state could not be persisted for {0}: {1} - import the Gameball metadata (system-objecttype-extensions.xml)',
            readCustomerNo(profile) || 'unknown', e && e.message);
    }
}

/**
 * Composes the operator-facing failure summary stored in gbLastSyncError.
 *
 * Format is '<httpStatus>|<gameballCode>|<requestId>|<message>'. requestId is
 * first-class rather than buried in the message because it is the token
 * Gameball support asks for, and an operator copying it out of a Business
 * Manager field should not have to find it inside a sentence.
 *
 * The payload is never included. It carries email, firstName, lastName and
 * dateOfBirth, all of which are on the build plan's REDACT list, and a custom
 * attribute is readable by anyone with the generic BM customer permission.
 * Note the message itself can still name an email address on a 3008 duplicate -
 * that is flagged for the shared scrubber when it lands, and is the reason the
 * message is bounded rather than stored whole.
 *
 * @param {{httpStatus: (number|undefined), code: string, requestId: string, message: string}} classification
 * @returns {string} at most ERROR_LINE_MAX characters
 */
function describeFailure(classification) {
    var message = String(classification.message || 'no error message');
    if (message.length > ERROR_MESSAGE_MAX) {
        message = message.substring(0, ERROR_MESSAGE_MAX);
    }

    var line = (classification.httpStatus || '') + '|' + (classification.code || '') + '|' + (classification.requestId || '') + '|' + message;

    return line.length > ERROR_LINE_MAX ? line.substring(0, ERROR_LINE_MAX) : line;
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
 * Factored out because several separate guards emit it and the exact string is
 * contractual - the acceptance procedure greps for it verbatim, so hand-copied
 * duplicates would be so many chances for one to drift.
 *
 * @param {boolean} infoOn - the memoised gameballInfoLogEnabled read
 * @param {string} source - the SFCC trigger, e.g. ACCOUNT_SAVE_PROFILE
 * @param {string} reason - no_profile | source_disabled | no_customer_no |
 *        no_email | no_customer_id | already_sent_this_request
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
 * Records the outcome of a call that Gameball accepted.
 *
 * gbSyncHash is written only when the digest actually produced a value. On a
 * digest failure the hash is '' and the PREVIOUS stored hash is left alone
 * rather than overwritten with '': the old value is still a truthful record of
 * the last payload Gameball accepted, and throwing it away would convert a
 * temporary hashing problem into a permanent re-POST of that profile on every
 * sweep.
 *
 * @param {dw.customer.Profile} profile
 * @param {string} hash
 * @param {string} source
 * @param {string} gameballId - '' when the response carried none
 */
function persistAccepted(profile, hash, source, gameballId) {
    var attrs = {
        gbSyncState: SYNC_STATE_SYNCED,
        gbLastSyncAt: new Date(),
        gbSyncSource: source,
        gbLastSyncError: null
    };

    if (hash) {
        attrs.gbSyncHash = hash;
    }

    if (gameballId) {
        attrs.gbGameballId = gameballId;
    }

    persistSyncState(profile, attrs);
}

/**
 * Records the outcome of a call Gameball rejected or that never arrived.
 *
 * The entire retry policy of this item is one boolean here, and it is worth
 * being explicit about why there is nothing else: suppressRetry writes the
 * hash on a PERMANENT rejection, so the profile stops looking changed and the
 * hourly sweep leaves it alone until it genuinely changes again. Withholding
 * the hash on a transient failure is, symmetrically, the retry ticket - the
 * profile still looks changed on the next sweep. That is the whole mechanism.
 * There is no attempt counter, no backoff ladder and no dead-letter state,
 * because there is no queue, and it is self-limiting: an unfixable profile
 * stops being retried once it falls out of the lookback window.
 *
 * That self-limit is what the identical-failure guard below protects, and
 * without it the promise is simply false. A custom-attribute write is a
 * persistent-object write, so writing FAILED and a fresh gbLastSyncAt bumps
 * Profile.lastModified - the very field the delta sweep derives its window
 * from, and the same mechanism this file relies on everywhere else to justify
 * NOT writing on the unchanged path. A profile failing transiently would
 * therefore refresh its own last-modified date on every attempt and could never
 * age out of the window: the retry would keep resetting the clock it is
 * supposed to run out. At the shipped defaults, five hundred such profiles
 * would consume the entire per-run call budget every hour, forever, so no
 * genuinely changed profile beyond them would ever be sent - while the run
 * reported Status.OK. Declining to rewrite a verdict already on the profile
 * means an unchanging failure stops moving lastModified, ages out of the window
 * on schedule, and the bound the metadata promises is real.
 *
 * The cost, accepted deliberately: gbLastSyncAt stops advancing while an
 * identical failure repeats, so it reads "when this failure was first recorded"
 * rather than "when it was last attempted". The attribute's own description
 * says so. The alternative - a first-failure timestamp attribute so the
 * per-attempt time could keep moving - buys an operator nothing that
 * gbLastSyncError does not already tell them, and costs a seventh attribute on
 * every customer record.
 *
 * @param {dw.customer.Profile} profile
 * @param {string} hash
 * @param {string} source
 * @param {Object} classification - the gameballErrors.classify verdict
 * @param {boolean} suppressRetry - true only for a PERMANENT disposition
 */
function persistRejected(profile, hash, source, classification, suppressRetry) {
    var summary = describeFailure(classification);

    // Only ever skipped when there is genuinely nothing to write: same state,
    // same entry point, same failure, and no hash waiting to be recorded. A
    // PERMANENT rejection whose hash is available always writes, because that
    // hash is the thing that stops the retry - never trade it for a saved
    // write. The same "do not rewrite a verdict that is already there" guard
    // gameballOrderApi.js:60-62 applies to orders, applied here for the sharper
    // reason that this rewrite feeds the sweep that produced it.
    if (!(suppressRetry && hash)
            && readCustomAttr(profile, 'gbSyncState') === SYNC_STATE_FAILED
            && readCustomAttr(profile, 'gbSyncSource') === source
            && readCustomAttr(profile, 'gbLastSyncError') === summary) {
        return;
    }

    var attrs = {
        gbSyncState: SYNC_STATE_FAILED,
        gbLastSyncAt: new Date(),
        gbSyncSource: source,
        gbLastSyncError: summary
    };

    if (suppressRetry && hash) {
        attrs.gbSyncHash = hash;
    }

    persistSyncState(profile, attrs);
}

/**
 * Upserts one profile to Gameball's idempotent POST integrations/customers
 * endpoint (build-plan section 13.4).
 *
 * Never throws: every failure path is logged and swallowed so a Gameball outage
 * can never break a storefront form POST, roll back an OCAPI customer create,
 * or truncate a job sweep.
 *
 * Two independent idempotency mechanisms sit in front of the call and they
 * answer different questions. The payload hash answers "has Gameball already
 * accepted exactly this content", which is what stops the hourly delta sweep
 * re-POSTing every unchanged profile in its lookback window; the per-request
 * memo answers "has this request already sent this customer", which is the
 * regression alarm for a second dispatch path appearing in one route. Either
 * alone leaves a real hole: the hash cannot see two calls in one request before
 * the first has committed, and the memo is inert in a job.
 *
 * The log lines below still read sendCustomer even though the body now lives
 * in sendProfile. That is deliberate: those exact strings are the acceptance
 * evidence for the one-upsert-per-request invariant and are grepped verbatim,
 * so renaming them to match the enclosing function would silently break the
 * only check that proves the invariant holds.
 *
 * @param {dw.customer.Profile|null} profile
 * @param {string} source - one of the canonical entry-point values documented
 *        on customerSyncGate.evaluate. Persisted to gbSyncSource and logged;
 *        never sent to Gameball.
 * @returns {{sent: boolean, state: string, reason: string,
 *            disposition: (string|undefined), configError: (boolean|undefined),
 *            httpStatus: (number|undefined)}}
 *          sent is true only when a call was actually issued, whatever its
 *          outcome. state is the value written to gbSyncState, 'UNCHANGED'
 *          when the hash short-circuited, or '' when a gate stopped the call
 *          before any state could be written.
 */
function sendProfile(profile, source) {
    try {
        // Both gates are read once per call and reused by every line below,
        // rather than re-reading the site preference inside each log call
        // (H28). This function can log twice, and a preference read is not
        // free enough to spend on a line that may never be written.
        var infoOn = isInfoLogEnabled();
        var debugOn = isDebugLogEnabled();
        var sfccRequestId = getRequestId();

        var gate = customerSyncGate.evaluate(profile, source);
        if (!gate.shouldSync) {
            if (gate.reason === 'gameball_disabled') {
                // debug, not info: on a site with Gameball switched off this
                // would otherwise fire on every profile save, which is a
                // non-event.
                if (debugOn) {
                    Logger.debug('gameballCustomerApi~sendCustomer upsert skipped (source={0}, reason=integration_disabled, sfccRequestId={1})',
                        source, sfccRequestId);
                }
            } else {
                // Promoted from a silent return. The registration path used to
                // land here whenever customer resolution fell back to the
                // anonymous customer, leaving no evidence at all that a sync
                // had been dropped.
                logSkipped(infoOn, source, gate.reason, readCustomerNo(profile), sfccRequestId);
            }

            // Avoid rewriting the same SKIPPED state (and triggering an
            // unnecessary profile save) on every repeat call - the same guard
            // gameballOrderApi.js:60-62 applies to orders. Without it, a site
            // with the Data-API source switched off would write to every
            // profile on every Data-API request, and each of those writes bumps
            // lastModified and pulls the profile straight back into the delta
            // sweep's window.
            //
            // source_disabled additionally never overwrites a SYNCED profile,
            // and that exception is about truthfulness rather than write
            // volume. "This entry point is switched off" is a fact about the
            // SITE, not about the customer: a fully-synced shopper whose CRM
            // then PATCHes a field Gameball never receives would otherwise be
            // relabelled SKIPPED, and nothing would ever put it back - the hash
            // short-circuit returns before any write by design, so the sweep
            // that follows repairs nothing. The whole operator promise of these
            // attributes is that "did this customer sync" can be answered off
            // the Business Manager screen, and that answer would be wrong
            // permanently. The other two skip reasons - no customer number, no
            // email while the email gate is on - ARE facts about the profile,
            // so they still overwrite.
            var overwritesSynced = gate.reason === 'source_disabled'
                && readCustomAttr(profile, 'gbSyncState') === SYNC_STATE_SYNCED;

            if (gate.skipState && !overwritesSynced && readCustomAttr(profile, 'gbSyncState') !== gate.skipState) {
                persistSyncState(profile, {
                    gbSyncState: gate.skipState,
                    gbSyncSource: source,
                    gbLastSyncAt: new Date()
                });
            }

            return { sent: false, state: gate.skipState || '', reason: gate.reason };
        }

        var payload = customerPayload.build(profile);
        var customerId = payload && payload.customerId;
        if (!customerId) {
            // Belt-and-braces on top of the gate's own no_customer_no rule
            // (H22): the gate reads profile.customerNo, this reads what the
            // builder actually put in the body, and only the second is the
            // value that would go on the wire. A future builder change that
            // stopped populating customerId would otherwise send an upsert
            // with no key, earning a guaranteed 3000/3001 and spending one of
            // the 360-per-30s customer-POST budget to do it.
            logSkipped(infoOn, source, 'no_customer_id', '', sfccRequestId);
            return { sent: false, state: '', reason: 'no_customer_id' };
        }

        // The single most important line in this item. An unchanged profile
        // makes NO API call and, just as importantly, NO attribute write:
        // writing gbLastSyncAt here would bump lastModified on every unchanged
        // profile the sweep touches and make the sweep permanently self-feeding.
        //
        // A '' hash (digest unavailable) deliberately never matches, so the
        // sync proceeds. Fail-open: a broken hash costs quota, a fail-closed
        // hash costs the whole feature, silently.
        var hash = gameballPayloadHash.of(payload);
        if (hash && hash === readCustomAttr(profile, 'gbSyncHash')) {
            return { sent: false, state: SYNC_STATE_UNCHANGED, reason: 'hash_unchanged' };
        }

        if (wasSentThisRequest(sfccRequestId, customerId)) {
            // The regression alarm for the exact class of bug this module was
            // refactored to remove: a second dispatch path in one request.
            logSkipped(infoOn, source, 'already_sent_this_request', customerId, sfccRequestId);
            return { sent: false, state: '', reason: 'already_sent_this_request' };
        }

        // Marked BEFORE the call, not after, so an exception inside the
        // service call still blocks a second attempt in the same request.
        markSentThisRequest(sfccRequestId, customerId);

        var result = gameballService.call({
            path: 'integrations/customers',
            body: payload
        });

        var classification = gameballErrors.classify(result, { scope: 'CUSTOMER' });
        var disposition = classification.disposition;

        if (disposition === gameballErrors.DISPOSITION.SUCCESS || disposition === gameballErrors.DISPOSITION.ALREADY_APPLIED) {
            // 7001 "customer already exists" is treated as normal upsert
            // semantics - the desired end state is the actual end state - and
            // is handled identically to a 200 except that its body carries no
            // gameballId, so readGameballId returns '' and the stored id is
            // left as it was.
            //
            // UNVERIFIED, and the most consequential unverified assumption in
            // this file (no sandbox and no Test API Key in this environment).
            // 7001 is documented as an HTTP 422, i.e. a REJECTION, and build
            // plan section 13.4 nowhere states what it does to the
            // customerAttributes that were submitted with it. If those
            // attributes are NOT applied - the reading under which the code
            // fires at all on a documented upsert is that the create half was
            // refused because another Gameball customer already owns the
            // merging identity - then writing gbSyncHash here is wrong in the
            // expensive direction: the stored hash equals the freshly computed
            // one on every later path, including the delta sweep that is this
            // item's designated retry route, so the profile is never re-sent
            // even after the merchant fixes channel merging in the dashboard.
            // The documented remedy still works (clear gbSyncHash in Business
            // Manager to force a resync), but nothing points an operator at it,
            // because gbSyncState reads SYNCED and gbLastSyncError is blank.
            // Cheapest way to settle it, ~10 minutes on a sandbox: POST an
            // existing customerId under channel merging until 7001 comes back,
            // then GET /integrations/customers/{id} and see whether the
            // submitted attributes moved. If they did not, this branch must
            // stop clearing gbLastSyncError and stop writing the hash.
            var gameballId = readGameballId(result);

            if (disposition === gameballErrors.DISPOSITION.ALREADY_APPLIED) {
                if (infoOn) {
                    Logger.warn('gameballCustomerApi~sendCustomer upsert not applied, customer already exists (source={0}, customerId={1}, sfccRequestId={2}, code={3}, gbRequestId={4}): {5}',
                        source, customerId, sfccRequestId, classification.code, classification.requestId, classification.message);
                }
            } else if (infoOn) {
                // A 200 whose body is not the documented { gameballId } object
                // still succeeded - gameballService.parseResponse falls back to
                // raw text, so gameballId simply prints empty. A response shape
                // is never a reason to downgrade a 200 to a failure.
                Logger.info('gameballCustomerApi~sendCustomer upsert sent (source={0}, customerId={1}, gameballId={2}, sfccRequestId={3})',
                    source, customerId, gameballId, sfccRequestId);
            }

            persistAccepted(profile, hash, source, gameballId);

            return {
                sent: true,
                state: SYNC_STATE_SYNCED,
                reason: '',
                disposition: disposition,
                httpStatus: classification.httpStatus
            };
        }

        var isConfig = disposition === gameballErrors.DISPOSITION.CONFIG;
        var isPermanent = disposition === gameballErrors.DISPOSITION.PERMANENT;

        if (isConfig || isPermanent) {
            // Ungated (H28). CONFIG is a merchant-configuration failure that
            // will fail identically on every record until someone acts, and
            // PERMANENT means this payload will never be accepted as sent -
            // both are things an operator has to see.
            //
            // Note what changed here relative to the previous hand-rolled
            // table: an UNRECOGNISED code now classifies TRANSIENT (the shared
            // classifier's documented fail-safe) and therefore logs at warn
            // rather than error. That is a deliberate trade, not an oversight.
            // The compensating visibility is strictly better than the error
            // line it replaces: the failure is now persisted on the profile as
            // gbSyncState=FAILED plus gbLastSyncError, which an operator can
            // read per-customer in Business Manager and which survives log
            // rotation, whereas the old error line was the only trace and
            // vanished with the log file.
            Logger.error('gameballCustomerApi~sendCustomer upsert failed (source={0}, customerId={1}, sfccRequestId={2}, code={3}, gbRequestId={4}): {5}',
                source, customerId, sfccRequestId, classification.code, classification.requestId, classification.message);
        } else if (infoOn) {
            Logger.warn('gameballCustomerApi~sendCustomer upsert failed, transient (source={0}, customerId={1}, sfccRequestId={2}, code={3}, gbRequestId={4}): {5}',
                source, customerId, sfccRequestId, classification.code, classification.requestId, classification.message);
        }

        persistRejected(profile, hash, source, classification, isPermanent);

        return {
            sent: true,
            state: SYNC_STATE_FAILED,
            reason: classification.code || 'failed',
            disposition: disposition,
            configError: isConfig ? true : undefined,
            httpStatus: classification.httpStatus
        };
    } catch (e) {
        // Never gated (H28). getRequestId() is re-read rather than referenced
        // because the throw may have come from the gate reads above, before
        // sfccRequestId was ever assigned - and this line is the whole reason
        // an undefined-preference read is now visible instead of being
        // swallowed message-less the way this function used to end.
        Logger.error('gameballCustomerApi~sendCustomer exception (source={0}, sfccRequestId={1}): {2}',
            source, getRequestId(), e && e.message);
        return { sent: false, state: '', reason: 'exception' };
    }
}

/**
 * Null/exception-safe unwrap of a dw.customer.Customer to its Profile.
 *
 * Tests for the getProfile FUNCTION rather than reading a .profile property,
 * because both storefront call sites can hand over an SFRA account model on
 * some SFRA versions, and such a model's .profile is a plain object carrying
 * firstName/lastName/email and no customerNo. Accepting it would build a
 * payload with no upsert key. Asserting the API method instead is what makes
 * the "could not resolve" path visible rather than silently sending nothing.
 *
 * Guarded because sendCustomer must never throw, and an argument expression
 * evaluated before sendProfile's own try block would escape it.
 *
 * @param {dw.customer.Customer} customer
 * @returns {dw.customer.Profile|null}
 */
function readProfile(customer) {
    try {
        return (customer && typeof customer.getProfile === 'function' && customer.getProfile()) || null;
    } catch (e) {
        return null;
    }
}

/**
 * Customer-typed entry point, kept because both SFRA controller call sites hold
 * a dw.customer.Customer rather than a Profile.
 *
 * NOTE the return type changed with the introduction of sendProfile: this
 * returned a plain boolean and now returns sendProfile's result object. Both
 * existing call sites in Account.js ignore the return value, so nothing breaks
 * today - but an undocumented type change in a public export is how a merchant
 * extension quietly starts treating every outcome as truthy.
 *
 * @param {dw.customer.Customer} customer - the SFCC customer; its profile is
 *        read, so an anonymous customer is skipped with a WARN
 * @param {string} source - see customerSyncGate.evaluate
 * @returns {Object} whatever sendProfile returned
 */
function sendCustomer(customer, source) {
    return sendProfile(readProfile(customer), source);
}

module.exports = {
    sendCustomer: sendCustomer,
    sendProfile: sendProfile
};
