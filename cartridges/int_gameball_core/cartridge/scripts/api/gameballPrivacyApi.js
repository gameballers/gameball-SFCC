'use strict';

var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var erasureStore = require('*/cartridge/scripts/privacy/erasureStore');
var gameballErrors = require('*/cartridge/scripts/util/gameballErrors');

// The three-value vocabulary for GameballErasureRequest.gbSource, enumerated in
// that attribute's own <description>. Deliberately SEPARATE from the ten-value
// gbSyncSource vocabulary on Profile: these name how an erasure was requested,
// those name how an upsert was dispatched, and merging them would produce one
// list in which most values are impossible for either attribute.
var SOURCE_DATA_API = 'DATA_API';
var SOURCE_HELPER_API = 'HELPER_API';
var SOURCE_BM_MANUAL = 'BM_MANUAL';

// Classification scope for the shared error table. The DELETE scope is the only
// place in the cartridge where HTTP 404 and Gameball code 7000 mean SUCCESS -
// "the record is already gone" is the goal state here and a defect anywhere
// else - which is exactly why the scope exists rather than this file carrying
// its own table.
var SCOPE_DELETE = 'DELETE';

/**
 * Accepts either half of the pair a caller is likely to be holding.
 *
 * The cartridge's other public entry point is
 * gameballCustomerApi.sendCustomer(customer, source), so merchant code will
 * naturally have a dw.customer.Customer in hand and write
 * requestErasure(customer, source) immediately before CustomerMgr.removeCustomer.
 * A Customer has no customerNo, so without this the call would resolve an empty
 * id, enrol nothing, and return false - after which the customer is deleted and
 * the Gameball id is unrecoverable forever. Refusing the natural call shape on
 * the one path where the mistake is irreversible is not a contract worth
 * defending.
 *
 * getProfile is duck-typed rather than instanceof-checked so this works for
 * whatever the Data-API hook hands over, whose exact argument types are
 * UNVERIFIED (no sandbox in this environment).
 *
 * @param {dw.customer.Profile|dw.customer.Customer} candidate
 * @returns {dw.customer.Profile|null}
 */
function toProfile(candidate) {
    try {
        if (!candidate) {
            return null;
        }

        if (typeof candidate.getProfile === 'function') {
            return candidate.getProfile() || null;
        }

        return candidate;
    } catch (e) {
        return null;
    }
}

/**
 * Null/exception-safe read of a profile's customer number.
 *
 * @param {dw.customer.Profile|dw.customer.Customer} profile
 * @returns {string} '' when the profile or the number is absent or unreadable
 */
function readCustomerNo(profile) {
    try {
        var resolved = toProfile(profile);
        return (resolved && resolved.customerNo) || '';
    } catch (e) {
        return '';
    }
}

/**
 * Resolves the exact value this cartridge sends to Gameball as customerId.
 *
 * It is profile.customerNo and nothing else, because that is what
 * customerPayload.build() puts in the upsert body. An earlier draft of this
 * item also read an optional Profile.custom.gbCustomerId first, so that a
 * future minted-id scheme would be picked up with no diff here. That read is
 * CUT: no item in this train declares the attribute, and reading a custom
 * attribute the metadata does not ship is exactly the defect that left the
 * widget dead against Gameball_Enabled (H43). When such an attribute is
 * genuinely added, the lookup is added with it, in the same change.
 *
 * @param {dw.customer.Profile|dw.customer.Customer} profile
 * @returns {string} the customerId, or '' when there is nothing to erase -
 *          nothing was ever sent to Gameball under a blank id
 */
function resolveCustomerId(profile) {
    var customerNo = readCustomerNo(profile);
    return customerNo ? String(customerNo).replace(/^\s+|\s+$/g, '') : '';
}

/**
 * Forces an unrecognised source onto the documented value set.
 *
 * Never writes what it was given without checking, because gbSource is the
 * attribute an operator reads to answer "how did this erasure get here" and a
 * typo'd or undefined value makes that answer worthless. HELPER_API is the
 * right default: every path that is not the Data-API hook and not an operator
 * is, by definition, code calling the helper.
 *
 * @param {string} [source]
 * @returns {string} DATA_API | HELPER_API | BM_MANUAL
 */
function coerceSource(source) {
    var value = source ? String(source) : '';

    if (value === SOURCE_DATA_API || value === SOURCE_BM_MANUAL) {
        return value;
    }

    return SOURCE_HELPER_API;
}

/**
 * Clears Profile.custom.gbSyncHash so a profile that survives its erasure is
 * eventually re-sent in full rather than skipped forever as unchanged.
 *
 * The stored hash means "Gameball already holds exactly this payload". After a
 * confirmed erasure that statement is simply false - Gameball holds nothing -
 * so leaving it in place would make every later sync short-circuit on
 * "hash_unchanged" and the profile would never be recreated. A shopper who
 * erased their loyalty profile and later wanted back in would be permanently
 * unable to earn points again, with no symptom on either side.
 *
 * It does NOT open a resurrection window, and the reason is worth stating
 * because an earlier version of this pair did exactly that. Clearing the hash
 * is a persistent write, so it bumps Profile.lastModified and drags the profile
 * into the customer delta job's lookback window; the only thing standing
 * between that and a full re-upsert of name, email, mobile and date of birth
 * minutes after a hard delete is customerSyncGate, which refuses to sync any
 * profile carrying a tombstone - settled or not - for as long as the tombstone
 * exists. The two changes are one mechanism and must not be separated: without
 * the gate this write resurrects the shopper, and without this write the gate
 * eventually reopens onto a profile that can never be sent.
 *
 * Skipped entirely on the DATA_API path: there the profile is being destroyed
 * inside the platform's own delete transaction, so the write is at best
 * discarded with it, and at worst is one more thing that can throw on the one
 * path where a throw rolls back the customer deletion itself.
 *
 * Failure here is logged and swallowed (H20): the tombstone is already written
 * and that is the irreversible part; a stale hash is a recoverable annoyance an
 * operator can clear in Business Manager.
 *
 * @param {dw.customer.Profile} profile - already normalised by the caller
 * @param {string} source - the coerced source
 * @returns {void}
 */
function clearSyncHash(profile, source) {
    if (source === SOURCE_DATA_API) {
        return;
    }

    try {
        if (!profile || !profile.custom || !profile.custom.gbSyncHash) {
            return;
        }

        Transaction.wrap(function () {
            profile.custom.gbSyncHash = null;
        });
    } catch (e) {
        Logger.error('gameballPrivacyApi~requestErasure: could not clear gbSyncHash for {0}: {1}',
            readCustomerNo(profile) || 'unknown', e && e.message);
    }
}

/**
 * Enrols a raw Gameball customerId for deletion, with no SFCC profile involved.
 *
 * PUBLIC INTEGRATION POINT, and the ONLY remedy once the SFCC profile is
 * already gone - an operator reads the id off the Gameball dashboard and calls
 * this. It is the substitute for a Business Manager "Forget Customer" tool,
 * which is out of scope for this cartridge; the operator surface is this
 * function plus the job's red status in BM job history.
 *
 * Makes no HTTP call. The actual delete is performed by the
 * custom.Gameball.CustomerErasure job step, for three independently sufficient
 * reasons: the storefront HTTPClient.send quota is 16 per request and a loop
 * over 50 shoppers would breach it; an inline call from the OCAPI hook would
 * hold a database transaction open across a vendor round trip (P3); and a
 * Gameball outage must never be able to fail an SFCC deletion.
 *
 * Contract: NEVER throws. Idempotent.
 *
 * @param {string} customerId - the exact customerId previously sent to
 *        Gameball, case-preserved
 * @param {string} [source] - DATA_API | HELPER_API | BM_MANUAL; anything else
 *        becomes HELPER_API
 * @returns {boolean} true if a tombstone exists after this call
 */
function requestErasureById(customerId, source) {
    try {
        var key = customerId === null || customerId === undefined
            ? ''
            : String(customerId).replace(/^\s+|\s+$/g, '');

        if (!key) {
            Logger.warn('gameballPrivacyApi~requestErasureById: refused an empty customerId');
            return false;
        }

        return erasureStore.enrol(key, coerceSource(source));
    } catch (e) {
        Logger.error('gameballPrivacyApi~requestErasureById failed: {0}', e && e.message);
        return false;
    }
}

/**
 * Enrols a customer profile for right-to-be-forgotten deletion in Gameball.
 *
 * PUBLIC INTEGRATION POINT. Call this immediately BEFORE deleting the SFCC
 * profile - once the profile is gone the Gameball customerId can never be
 * recovered, and Gameball's delete endpoint takes no other identifier. SFCC
 * exposes no hook on CustomerMgr.removeCustomer, on Business Manager customer
 * deletion, or on the platform data-retention/anonymization job, so for every
 * deletion path except the OCAPI/SCAPI Data API this function is the only
 * capture mechanism that exists.
 *
 * Contract: NEVER throws, under any input - it is called from inside merchant
 * code that is about to delete a customer and must not be able to derail it.
 * Idempotent: calling it repeatedly for the same shopper updates one row and
 * never queues a second deletion.
 *
 * Note the quota ceiling on looping over this: a storefront request may create
 * at most 10 Custom Objects. Erasing more shoppers than that in one request is
 * a job, not a loop.
 *
 * Accepts a dw.customer.Customer as well as a dw.customer.Profile, because that
 * is what the cartridge's other public entry point takes and because on this
 * path the cost of rejecting the wrong shape is a mandate that can never be
 * recovered.
 *
 * @param {dw.customer.Profile|dw.customer.Customer} profile - the profile (or
 *        its customer) about to be deleted, read while it still exists
 * @param {string} [source] - DATA_API | HELPER_API | BM_MANUAL; anything else
 *        becomes HELPER_API
 * @returns {boolean} true if a tombstone exists after this call, whether it was
 *          created now or was already present
 */
function requestErasure(profile, source) {
    try {
        var resolved = toProfile(profile);

        if (!resolved) {
            // Error, not warn, here and below. Everywhere else in this file a
            // missing input is a benign skip; on this call it means the caller
            // is about to delete a customer whose Gameball id will then be
            // unrecoverable forever, and a WARN line reading like a skip is how
            // that goes unnoticed.
            Logger.error('gameballPrivacyApi~requestErasure: no profile or customer supplied; NOTHING was enrolled and the Gameball id will be unrecoverable once the customer is deleted');
            return false;
        }

        var customerId = resolveCustomerId(resolved);
        if (!customerId) {
            Logger.error('gameballPrivacyApi~requestErasure: profile has no customerNo; NOTHING was enrolled. If this shopper was ever synced to Gameball, read their id from the Gameball dashboard and call requestErasureById before the SFCC record is deleted');
            return false;
        }

        var coerced = coerceSource(source);
        var enrolled = erasureStore.enrol(customerId, coerced);

        if (enrolled) {
            clearSyncHash(resolved, coerced);
        }

        return enrolled;
    } catch (e) {
        Logger.error('gameballPrivacyApi~requestErasure failed for {0}: {1}',
            readCustomerNo(profile) || 'unknown', e && e.message);
        return false;
    }
}

/**
 * Reads the current state of an erasure request, so a DSAR controller can
 * report progress to the data subject instead of enrolling and hoping.
 *
 * Contract: NEVER throws. Returns null when no row exists - which means either
 * that no erasure was ever requested for this id, or that a completed one has
 * already been purged. Those two are deliberately not distinguished: keeping a
 * record of who was erased, after they were erased, is the thing bounded
 * retention exists to stop.
 *
 * @param {string} customerId
 * @returns {({status: string, source: string, requestedAt: (Date|null),
 *            completedAt: (Date|null), attempts: number}|null)}
 */
function getErasureStatus(customerId) {
    try {
        var row = erasureStore.read(customerId);
        if (!row) {
            return null;
        }

        var attempts = parseInt(row.custom.gbAttempts, 10);

        return {
            status: String(row.custom.gbStatus || ''),
            source: String(row.custom.gbSource || ''),
            requestedAt: row.custom.gbRequestedAt || null,
            completedAt: row.custom.gbCompletedAt || null,
            attempts: isNaN(attempts) ? 0 : attempts
        };
    } catch (e) {
        Logger.error('gameballPrivacyApi~getErasureStatus failed: {0}', e && e.message);
        return null;
    }
}

/**
 * Performs ONE delete attempt against Gameball and classifies the outcome.
 *
 * No retry loop, no recursion, no sleep - SFCC has none (P12), and the erasure
 * job's 30-minute interval IS the backoff. There is deliberately no
 * gbNextAttemptAt ladder: layering a capped-exponential schedule on top of a
 * 30-minute cron buys nothing.
 *
 * Endpoint: POST {base}/integrations/customers/{customerId}/delete - the
 * documented alias of DELETE {base}/integrations/customers/{customerId} (build
 * plan section 13.6). A HARD delete: Gameball has no anonymize endpoint and no
 * soft delete, and there is no undo. The POST alias is used rather than the
 * DELETE verb because it exercises exactly the method, header set and
 * body-serialisation path every other call in this cartridge already uses, so
 * it cannot be broken by another item editing gameballService.js, and because
 * how SFCC's service framework frames a DELETE with a null body is UNVERIFIED
 * here. body {} serialises to the literal {}, which is valid JSON and cannot
 * trip a server-side "expected a body" check. Documented fallback if the alias
 * 404s on a given Gameball account: { method: 'DELETE', path:
 * 'integrations/customers/' + encodeURIComponent(id) } with no body - still
 * zero change to gameballService.js.
 *
 * That fallback is only reachable if the symptom is visible, which is why a
 * 404 is NOT unconditionally success here. "This customer is already gone" and
 * "this endpoint does not exist on this account" arrive as the same status
 * line; gameballErrors settles the mandate only when the response carried
 * Gameball's own requestId, and the job step turns the whole run red when every
 * call in it came back as a bare 404, naming this fallback. Before trusting a
 * green run on a new account, confirm one real deletion in the Gameball
 * dashboard - see docs/gameball-gdpr.md section 8.
 *
 * The customerId is encodeURIComponent'd and NEVER truncated, even though
 * Gameball documents a 100-character maximum: a truncated id addresses a
 * different record, and on a hard delete that is unrecoverable. An over-long id
 * earns a 400 and a visible FAILED row instead.
 *
 * Called by the erasure job step only; exported rather than kept private so the
 * step does not have to know the endpoint shape.
 *
 * Contract: NEVER throws. A thrown exception is returned as TRANSIENT, so the
 * row is retried rather than silently lost.
 *
 * @param {string} customerId
 * @returns {{disposition: string, httpStatus: number, gameballCode: string,
 *            requestId: string, message: string}} disposition is a
 *          gameballErrors.DISPOSITION value
 */
function deleteCustomer(customerId) {
    try {
        var key = customerId === null || customerId === undefined
            ? ''
            : String(customerId).replace(/^\s+|\s+$/g, '');

        if (!key) {
            return {
                disposition: gameballErrors.DISPOSITION.PERMANENT,
                httpStatus: 0,
                gameballCode: '',
                requestId: '',
                message: 'refused to call Gameball with an empty customerId'
            };
        }

        // Late require, and the one place in this file that departs from H2.
        // gameballService calls LocalServiceRegistry.createService at module
        // scope, and only this function - reached exclusively from the job step
        // - needs it, so only this function resolves it (H3). What that buys is
        // narrow and worth stating precisely: merchant code that requires this
        // module to call requestErasure or getErasureStatus never touches the
        // service registry, so an instance where services.xml was never
        // imported still enrols erasures instead of throwing on require.
        //
        // It does NOT protect the Data-API delete hook, and an earlier comment
        // here claimed it did. That path is ocapiDataCustomerHooks ->
        // ocapiCustomerHookRunner -> gameballCustomerApi -> gameballService, so
        // the registry is already resolved before beforeDELETE runs. The
        // protection on that path is the runner's own try/catch, not this line.
        var gameballService = require('*/cartridge/scripts/services/gameballService');

        var result = gameballService.call({
            // Stated explicitly even though POST is createRequest's own default
            // (S7): a call whose verb is inferred is a call whose verb changes
            // when somebody edits a shared default.
            method: 'POST',
            path: 'integrations/customers/' + encodeURIComponent(key) + '/delete',
            body: {}
        });

        // Classification goes through the shared table, scope DELETE. An
        // earlier draft carried a private classifyDeleteResult here; it is CUT
        // in favour of gameballErrors so that four items cannot drift into four
        // opinions about what 1001 means. Note this reads only the dw.svc.Result
        // envelope - never result.getObject() as the source of truth - so a
        // later parseResponse rewrite (drift D5) cannot break it.
        var classification = gameballErrors.classify(result, { scope: SCOPE_DELETE });

        return {
            disposition: classification.disposition,
            httpStatus: classification.httpStatus || 0,
            gameballCode: classification.code || '',
            requestId: classification.requestId || '',
            message: classification.message || ''
        };
    } catch (e) {
        // Logged here because nothing downstream can. The outcome's message
        // field is deliberately excluded from gbStatusDetails - it can carry an
        // echoed response body, and this store must not - so without this line
        // the exception text is dropped on the floor and the row records only
        // "disposition=TRANSIENT http=0 code= requestId=" five times before
        // going FAILED. An operator would then have a red job, a 14-day
        // deadline, and no cause to chase. The customerId is on the sanctioned
        // KEEP list and the exception message is ours, not the shopper's.
        Logger.error('gameballPrivacyApi~deleteCustomer: erasure call for {0} threw: {1}',
            customerId, e && e.message);

        return {
            disposition: gameballErrors.DISPOSITION.TRANSIENT,
            httpStatus: 0,
            gameballCode: '',
            requestId: '',
            message: 'exception during erasure call: ' + (e && e.message)
        };
    }
}

module.exports = {
    requestErasure: requestErasure,
    requestErasureById: requestErasureById,
    getErasureStatus: getErasureStatus,
    deleteCustomer: deleteCustomer
};
