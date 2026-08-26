'use strict';

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.queue');

// The tombstone type, and the ONLY Custom Object this module - or any module in
// the cartridge - is permitted to write erasure state into. It is deliberately
// single-purpose: one row shape, three statuses, no payload column, no event
// kind, no priority. A general outbound-event queue was decided out of scope,
// and the word "Queue" was struck from the type name for exactly that reason -
// a generic-sounding store is an invitation to reuse it as one.
//
// It exists at all only because the identifier is destroyed by the very
// operation being observed: once the SFCC profile is gone, the Gameball
// customerId can never be recovered from anywhere in SFCC, so there is no
// alternative place to remember it.
var CO_TYPE = 'GameballErasureRequest';

// The value set enumerated in the type's own <description> so a merchant can
// read the state machine off the Business Manager screen (H39). Plain strings
// rather than enum-of-string on purpose: writing an out-of-set value to an
// enum-of-string attribute throws, and every function in this file runs on a
// path that must never throw.
var STATUS_PENDING = 'PENDING';
var STATUS_SUCCESS = 'SUCCESS';
var STATUS_FAILED = 'FAILED';

// Last-resort default for gbSource. gameballPrivacyApi.coerceSource is the
// authority on the three-value vocabulary and every real caller goes through
// it; this is only what a direct caller that passed nothing gets, because
// writing an empty gbSource would leave an operator with a row that names no
// origin at all. The literal is duplicated in gameballPrivacyApi rather than
// imported so the two modules cannot form a require cycle over a string.
var DEFAULT_SOURCE = 'HELPER_API';

// gbStatusDetails budget. The composed line is short by construction - four
// named fields, no free text - so this is a backstop against a pathological
// requestId rather than a real bound.
var STATUS_DETAILS_MAX_LENGTH = 500;

// Upper bound on rows removed in one purge pass. The purge runs before the
// drain inside the same job step, so it must not be able to spend the step's
// whole wall clock on housekeeping; whatever it does not reach this run it
// reaches on the next.
var MAX_PURGE_ROWS = 1000;

// Upper bound on the standing-FAILED census. The number is only ever compared
// against zero and printed in one operator-facing sentence, so counting past
// this would spend reads to change nothing: "at least 200 unresolved erasure
// mandates" and "437 unresolved erasure mandates" call for the same action.
var MAX_FAILED_COUNT = 200;

var MS_PER_DAY = 86400000;

// Logging note, stated once for the whole module. Nothing here gates on
// gameballInfoLogEnabled, which is a deliberate departure from H28. Two
// reasons. First, enrol() runs inside the OCAPI/SCAPI Data-API delete hook,
// whose base path is /s/-/dw/data/ where '-' literally means "no site" - a site
// preference read there is a live throw risk on the one code path in the
// cartridge that must never throw, because a throw inside the platform's delete
// transaction rolls back the customer deletion itself. Second, the volume does
// not need gating: this module writes at most one info line per erasure
// REQUEST, so its log volume is bounded by how many shoppers exercise a right
// to be forgotten, not by storefront traffic.

/**
 * Trims a customerId into a usable Custom Object key.
 *
 * The key IS the customerId - never a UUID - which is what makes enrolment an
 * idempotent upsert and makes a lost create race harmless. Guarded rather than
 * read inline because the value arrives from a hook argument, from merchant
 * code, or from an operator pasting it out of the Gameball dashboard, and none
 * of those is guaranteed to be a string.
 *
 * @param {string} customerId
 * @returns {string} the trimmed id, or '' when there is nothing usable
 */
function normaliseKey(customerId) {
    try {
        if (customerId === null || customerId === undefined) {
            return '';
        }

        return String(customerId).replace(/^\s+|\s+$/g, '');
    } catch (e) {
        return '';
    }
}

/**
 * Null/exception-safe read of one row by key.
 *
 * getCustomObject throws when the type has not been imported at all, which is
 * the normal state of a code-then-metadata release, so the miss and the
 * missing-type case are folded into the same null answer here and the type
 * problem is reported once, by the caller that was going to write.
 *
 * @param {string} key
 * @returns {dw.object.CustomObject|null}
 */
function readRow(key) {
    try {
        return CustomObjectMgr.getCustomObject(CO_TYPE, key) || null;
    } catch (e) {
        return null;
    }
}

/**
 * Null/exception-safe read of one attribute off a row.
 * @param {dw.object.CustomObject} row
 * @param {string} name
 * @returns {*} undefined when absent or unreadable
 */
function readAttr(row, name) {
    try {
        return row && row.custom ? row.custom[name] : undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * @param {dw.object.CustomObject} row
 * @returns {string} the row's status, or '' when absent or unreadable
 */
function readStatus(row) {
    var value = readAttr(row, 'gbStatus');
    return value === null || value === undefined ? '' : String(value);
}

/**
 * @param {dw.object.CustomObject} row
 * @returns {number} attempts so far, 0 when absent or unreadable. Never trusts
 *          the metadata <default-value>: that applies only to objects created
 *          after the import, so a row created by an earlier build reads null.
 */
function readAttempts(row) {
    var parsed = parseInt(readAttr(row, 'gbAttempts'), 10);
    return isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/**
 * Composes the bounded, scrubbed diagnostic stored in gbStatusDetails.
 *
 * Four NAMED fields only - our own disposition, the HTTP status, Gameball's
 * error code and Gameball's requestId - and deliberately NOT the classifier's
 * message. That message falls back to the raw response body when Gameball's
 * envelope will not parse, and a raw body can echo submitted fields back at us.
 * This store is keyed on a pseudonymous identifier that an erasure request
 * exists to remove; putting anything else about that shopper in it, even
 * transiently, is the thing the whole item is trying to prevent. requestId is
 * kept because it is the one token Gameball support asks for.
 *
 * Lives here rather than in gameballPrivacyApi because this is the module that
 * owns the attribute, and a bound that lives away from the write it bounds is a
 * bound that eventually stops being applied.
 *
 * @param {{disposition: string, httpStatus: number, gameballCode: string, requestId: string}} outcome
 * @returns {string} at most STATUS_DETAILS_MAX_LENGTH characters
 */
function buildStatusDetails(outcome) {
    var safe = outcome || {};
    var line = 'disposition=' + String(safe.disposition || 'UNKNOWN')
        + ' http=' + String(safe.httpStatus || 0)
        + ' code=' + String(safe.gameballCode || '')
        + ' requestId=' + String(safe.requestId || '');

    return line.length > STATUS_DETAILS_MAX_LENGTH ? line.substring(0, STATUS_DETAILS_MAX_LENGTH) : line;
}

/**
 * Creates a fresh PENDING tombstone.
 *
 * The create sits in its own inner try/catch (H20) whose catch RE-READS the
 * key, because createCustomObject on an existing key throws and two Data-API
 * deletes - or a hook and a merchant helper call - can genuinely reach this
 * line at the same moment. Losing that race means somebody else has already
 * enrolled this exact shopper, which is the outcome we wanted, so it is
 * reported as success rather than as a failure to enrol.
 *
 * @param {string} key
 * @param {string} source
 * @returns {boolean} true if a tombstone exists after this call
 */
function createRow(key, source) {
    try {
        Transaction.wrap(function () {
            // All four attributes in ONE transaction (P2). A row that committed
            // with a key but no status would be invisible to the drain's
            // query and would sit there until retention swept it - a silently
            // lost erasure mandate.
            var created = CustomObjectMgr.createCustomObject(CO_TYPE, key);
            created.custom.gbStatus = STATUS_PENDING;
            created.custom.gbSource = source;
            created.custom.gbRequestedAt = new Date();
            created.custom.gbAttempts = 0;
        });

        Logger.info('erasureStore~enrol: enrolled {0} from {1}', key, source);
        return true;
    } catch (e) {
        if (readRow(key)) {
            return true;
        }

        Logger.error('erasureStore~enrol: could not enrol {0} - import the Gameball metadata (GameballErasureRequest): {1}',
            key, e && e.message);
        return false;
    }
}

/**
 * Returns a FAILED row to PENDING with a fresh attempt budget.
 *
 * gbRequestedAt is deliberately left at its original value: it is the start of
 * the merchant's statutory response clock, and a re-request must not be able to
 * restart it. gbCompletedAt is cleared because a row that is pending again has
 * not completed.
 *
 * @param {dw.object.CustomObject} row
 * @param {string} key
 * @returns {boolean} true if a PENDING tombstone exists after this call
 */
function resetRow(row, key) {
    try {
        Transaction.wrap(function () {
            row.custom.gbStatus = STATUS_PENDING;
            row.custom.gbAttempts = 0;
            row.custom.gbStatusDetails = null;
            row.custom.gbCompletedAt = null;
        });

        Logger.info('erasureStore~enrol: re-armed exhausted erasure for {0}', key);
        return true;
    } catch (e) {
        Logger.error('erasureStore~enrol: could not re-arm {0}: {1}', key, e && e.message);
        return false;
    }
}

/**
 * Creates or refreshes the tombstone for one Gameball customerId.
 *
 * The Custom Object key IS the customerId - deterministic, never a UUID (J18) -
 * which is what makes enrolment idempotent and makes a lost create race
 * harmless. The three existing-row outcomes are not symmetric and each is a
 * decision, not an oversight:
 *
 *   PENDING - left completely untouched. A second request for a shopper who is
 *             already queued must not reset gbRequestedAt, because that is the
 *             merchant's response clock. Note this is safe only because a
 *             PENDING row can no longer get stuck: the drain settles one whose
 *             gbAttempts has reached the ceiling straight to FAILED, from where
 *             a re-issue re-arms it. It is not this function's job to know the
 *             ceiling - it runs on the Data-API hook path, which reads no site
 *             preference at all.
 *   FAILED  - reset to PENDING with a fresh budget. A new request is a new
 *             mandate and deserves a fresh set of retries; the alternative
 *             (leave it FAILED) would mean an operator re-issuing an erasure
 *             from the Gameball dashboard silently achieved nothing.
 *   SUCCESS - left untouched. The Gameball record is already gone, and
 *             re-queuing would only earn a 404 that the drain classifies as
 *             success anyway.
 *
 * This answers only "have we already done this". Whether the feature is
 * switched on at all is a separate question asked much later, on the drain
 * (H38) - deliberately, because enrolment is the one irreversible moment in the
 * whole feature and every gate after it can be flipped with nothing lost.
 *
 * Contract: NEVER throws.
 *
 * @param {string} customerId - the exact value previously sent to Gameball
 * @param {string} source - already coerced to DATA_API | HELPER_API | BM_MANUAL
 *        by gameballPrivacyApi.coerceSource
 * @returns {boolean} true if a tombstone exists after this call, whether it was
 *          created now or was already there
 */
function enrol(customerId, source) {
    try {
        var key = normaliseKey(customerId);
        if (!key) {
            Logger.warn('erasureStore~enrol: refused an empty customerId from {0}', source || 'unknown');
            return false;
        }

        var sourceValue = source ? String(source) : DEFAULT_SOURCE;
        var existing = readRow(key);

        if (!existing) {
            return createRow(key, sourceValue);
        }

        var status = readStatus(existing);

        if (status === STATUS_PENDING) {
            return true;
        }

        if (status === STATUS_SUCCESS) {
            Logger.info('erasureStore~enrol: {0} is already erased from Gameball; nothing re-queued', key);
            return true;
        }

        // FAILED, and also anything unrecognised or absent. A row whose status
        // cannot be read is treated as exhausted rather than as pending on
        // purpose: assuming "pending" would mean a corrupt row silently
        // swallows every future erasure request for that shopper, while
        // assuming "exhausted" costs at most one extra idempotent delete.
        return resetRow(existing, key);
    } catch (e) {
        Logger.error('erasureStore~enrol: failed for {0}: {1}', normaliseKey(customerId) || 'unknown', e && e.message);
        return false;
    }
}

/**
 * Reads one tombstone.
 *
 * The sanctioned accessor for every other module: nothing outside this file
 * calls CustomObjectMgr for this type, so the drain and the public helper both
 * come through here.
 *
 * @param {string} customerId
 * @returns {(dw.object.CustomObject|null)} null when no row exists, which means
 *          either that no erasure was ever requested for this id or that a
 *          completed one has already been purged
 */
function read(customerId) {
    var key = normaliseKey(customerId);
    return key ? readRow(key) : null;
}

/**
 * Is there an erasure request on record for this customer at all?
 *
 * Exists so the customer sync gate can refuse to upsert a shopper whose erasure
 * has been requested. Without it the hourly delta sweep would recreate, in
 * Gameball, the very profile the drain is about to delete - and would then do
 * it again the next hour, forever.
 *
 * A SETTLED row blocks too, and that is a deliberate correction to the original
 * design, which reopened the gate the instant gbStatus became SUCCESS. Under
 * that rule an erasure was undone within one sweep interval whenever the SFCC
 * profile survived it: enrolment clears gbSyncHash (see gameballPrivacyApi),
 * which is itself a persistent write and therefore bumps Profile.lastModified
 * into the delta job's lookback window, and with no stored hash the
 * "unchanged" short-circuit could not fire either - so the next sweep re-POSTed
 * the shopper's name, email, mobile and date of birth to Gameball minutes after
 * a legally mandated hard delete, with nothing logged and the job green.
 *
 * The gate therefore stays shut for as long as the tombstone exists, which is
 * gameballErasureSuccessRetentionDays (default 7) after Gameball confirms the
 * deletion, or platform retention at 14 days for a FAILED one. Blocking a
 * FAILED row is not collateral damage but the point: an unhonoured mandate is
 * the last state in which more of that shopper's data should be sent.
 *
 * What this deliberately does NOT do is make the block permanent. There is no
 * opt-out flag on a Profile - consent gating is out of scope by decision - so
 * a shopper whose SFCC account survives their erasure is eventually synced
 * again by whichever path touches them first. docs/gameball-gdpr.md states that
 * plainly rather than implying a durability the platform cannot give: an
 * erasure is durable only when the SFCC customer is deleted too.
 *
 * Contract: NEVER throws; answers false on any failure, so a broken lookup
 * costs an unwanted upsert rather than silently stopping every customer in the
 * base from syncing.
 *
 * @param {string} customerId
 * @returns {boolean}
 */
function hasRequest(customerId) {
    try {
        return !!read(customerId);
    } catch (e) {
        return false;
    }
}

/**
 * Reads the four fields the drain needs to decide what to do with one row.
 *
 * Returns a plain snapshot rather than the CustomObject because this module is
 * the only one permitted to touch the type: handing the row out would put
 * row.custom reads in the job step, and the first person to add a fifth
 * attribute would then have two files to change.
 *
 * Contract: NEVER throws; null when the row is gone or unreadable, which the
 * caller must treat as "somebody else got there first", not as "not eligible".
 *
 * @param {string} customerId
 * @returns {({status: string, attempts: number, requestedAt: (Date|null),
 *            lastAttemptAt: (Date|null)}|null)}
 */
function readDrainState(customerId) {
    try {
        var row = read(customerId);
        if (!row) {
            return null;
        }

        return {
            status: readStatus(row),
            attempts: readAttempts(row),
            requestedAt: readAttr(row, 'gbRequestedAt') || null,
            lastAttemptAt: readAttr(row, 'gbLastAttemptAt') || null
        };
    } catch (e) {
        return null;
    }
}

/**
 * Counts the FAILED rows standing in the store, capped at MAX_FAILED_COUNT.
 *
 * The job's exit status is the only operator surface this iteration ships, and
 * a per-run failure counter is not enough to drive it: a row that exhausts its
 * budget at 02:05 turns that one run red and every run after it green, because
 * readPendingKeys never reads a FAILED row again. The mandate then sits
 * unhonoured behind a green job until platform retention destroys it on day 14
 * - the exact outcome the red status exists to prevent. This census is what
 * makes the job stay red until a human resolves the row, which is what the
 * gameballErasureMaxAttempts preference already promises the merchant in its
 * own description.
 *
 * Contract: NEVER throws; -1 when the census itself failed, which the caller
 * must not read as zero.
 *
 * @returns {number} standing FAILED rows, capped, or -1 when unreadable
 */
function countFailed() {
    var iterator = null;
    var count = 0;

    try {
        iterator = CustomObjectMgr.queryCustomObjects(CO_TYPE, 'custom.gbStatus = {0}', null, STATUS_FAILED);

        while (iterator.hasNext() && count < MAX_FAILED_COUNT) {
            // next() sits OUTSIDE the row guard on purpose, here and in the two
            // other iterating functions: a row whose ATTRIBUTES will not read is
            // skipped, but an iterator that will not ADVANCE must end the pass,
            // because catching that inside the loop produces a loop that cannot
            // terminate.
            var row = iterator.next();

            try {
                if (readStatus(row) === STATUS_FAILED) {
                    count++;
                }
            } catch (rowError) {
                // Counted, not skipped. A row we cannot read is not evidence
                // that there is no outstanding mandate, and this number only
                // ever decides whether a human is called.
                count++;
            }
        }
    } catch (e) {
        Logger.error('erasureStore~countFailed: census failed: {0}', e && e.message);
        return -1;
    } finally {
        if (iterator) {
            try {
                iterator.close();
            } catch (closeError) {
                // See readPendingKeys.
            }
        }
    }

    return count;
}

/**
 * Returns the keys of up to maxRows unsettled rows, oldest request first.
 *
 * Returns KEYS, not objects, and closes the SeekableIterator before returning.
 * That is not tidiness: the caller mutates every row it is handed, and mutating
 * rows inside a result set an iterator is still walking is a documented SFCC
 * hazard (P4). Collecting a closed page of strings and re-fetching each one
 * costs a handful of reads and removes the hazard entirely.
 *
 * The one predicate is gbStatus. An earlier version also filtered
 * "custom.gbAttempts < maxAttempts", putting eligibility in the query as J20
 * asks - and that turned out to be a trap for this particular table, because a
 * row the query excludes is not merely deferred, it is INVISIBLE: nothing else
 * ever visits a PENDING row, so it could never be settled, never counted,
 * never turn the job red, and would be destroyed by platform retention on day
 * 14 with no record it existed. Two ordinary events put a row there: an
 * operator lowering gameballErasureMaxAttempts after an outage, and an instance
 * restart between settleRetry (which had just reached the ceiling) and
 * settleFailed. The caller settles such a row FAILED without spending a call,
 * so it leaves the PENDING set on the first run that sees it and cannot eat the
 * page budget on any later one - which is the cost J20 exists to avoid.
 *
 * gbStatus is nevertheless re-asserted per row (P7) - SFCC search can match and
 * return documents with NULL values in the search fields, so the query is a
 * hint, not a guarantee.
 *
 * Contract: NEVER throws; returns [] on any failure.
 *
 * @param {number} maxRows - hard cap on the page size
 * @returns {string[]} customerIds, oldest request first
 */
function readPendingKeys(maxRows) {
    var keys = [];
    var iterator = null;

    try {
        iterator = CustomObjectMgr.queryCustomObjects(
            CO_TYPE,
            'custom.gbStatus = {0}',
            'custom.gbRequestedAt ASC',
            STATUS_PENDING
        );

        while (iterator.hasNext() && keys.length < maxRows) {
            // next() outside the guard, attribute reads inside it: see
            // countFailed for why an un-advanceable iterator must end the pass
            // rather than be swallowed per row.
            var row = iterator.next();

            // Per-row guard (H19): one unreadable row must not truncate the
            // page and strand every erasure behind it.
            try {
                var key = normaliseKey(readAttr(row, 'gbCustomerId'));

                if (key && readStatus(row) === STATUS_PENDING) {
                    keys.push(key);
                }
            } catch (rowError) {
                Logger.error('erasureStore~readPendingKeys: skipped an unreadable row: {0}', rowError && rowError.message);
            }
        }
    } catch (e) {
        Logger.error('erasureStore~readPendingKeys: query failed - import the Gameball metadata (GameballErasureRequest): {0}',
            e && e.message);
    } finally {
        if (iterator) {
            try {
                iterator.close();
            } catch (closeError) {
                // A SeekableIterator that will not close is not a reason to
                // throw away a page of erasure mandates; the platform reclaims
                // it when the step ends.
            }
        }
    }

    return keys;
}

/**
 * Marks a row SUCCESS.
 *
 * SUCCESS covers three facts that are indistinguishable from here and should
 * be: Gameball deleted the customer, Gameball never had the customer, and
 * Gameball had already deleted the customer. All three mean the state the
 * erasure request asked for is the state that exists.
 *
 * Contract: NEVER throws - the outcome-recording path must not itself be able
 * to fail the run (H20).
 *
 * @param {string} customerId
 * @param {{disposition: string, httpStatus: number, gameballCode: string, requestId: string}} outcome
 * @returns {void}
 */
function settleSuccess(customerId, outcome) {
    try {
        var row = read(customerId);
        if (!row) {
            return;
        }

        var now = new Date();
        var details = buildStatusDetails(outcome);
        var attempts = readAttempts(row) + 1;

        Transaction.wrap(function () {
            row.custom.gbStatus = STATUS_SUCCESS;
            row.custom.gbCompletedAt = now;
            row.custom.gbLastAttemptAt = now;
            row.custom.gbAttempts = attempts;
            row.custom.gbStatusDetails = details;
        });
    } catch (e) {
        Logger.error('erasureStore~settleSuccess: could not record success for {0}: {1}',
            normaliseKey(customerId) || 'unknown', e && e.message);
    }
}

/**
 * Records a failed-but-retryable attempt. Leaves gbStatus PENDING so the next
 * run picks the row up again.
 *
 * countAttempt is the whole point of the function existing separately from
 * settleFailed. SFCC's own rate limiter and its circuit breaker are valves the
 * PLATFORM closed - the call never reached Gameball - so burning a retry on one
 * would allow an SFCC-side wobble to exhaust a legal mandate (S26).
 *
 * Contract: NEVER throws.
 *
 * @param {string} customerId
 * @param {{disposition: string, httpStatus: number, gameballCode: string, requestId: string}} outcome
 * @param {boolean} countAttempt - false for SFCC-side rate limiting or an open
 *        circuit, which must not burn the retry budget
 * @returns {number} the row's gbAttempts value after this call, so the caller
 *          can decide whether the budget is now spent. -1 when the row could
 *          not be read or written at all, which the caller must not mistake
 *          for a spent budget.
 */
function settleRetry(customerId, outcome, countAttempt) {
    try {
        var row = read(customerId);
        if (!row) {
            return -1;
        }

        var attempts = readAttempts(row) + (countAttempt ? 1 : 0);
        var details = buildStatusDetails(outcome);
        var now = new Date();

        Transaction.wrap(function () {
            row.custom.gbLastAttemptAt = now;
            row.custom.gbAttempts = attempts;
            row.custom.gbStatusDetails = details;
        });

        return attempts;
    } catch (e) {
        Logger.error('erasureStore~settleRetry: could not record a retry for {0}: {1}',
            normaliseKey(customerId) || 'unknown', e && e.message);
        return -1;
    }
}

/**
 * Marks a row FAILED - permanently rejected, or out of retries.
 *
 * The row stays visible to an operator until platform retention purges it, and
 * the drain turns the whole job red while any row reached this state in the
 * run. That is deliberate and is the one place this cartridge's jobs
 * intentionally cry wolf: a handful of transiently failing ORDERS is a normal
 * self-healing state, but an erasure that ran out of retries is a legal mandate
 * nobody is going to notice unless something goes red.
 *
 * countAttempt exists because this function is reached two ways. On a permanent
 * rejection it follows a Gameball call and must count it; on a budget-exhausted
 * transition it follows settleRetry, which has already counted that same call,
 * and counting it twice would make gbAttempts disagree with
 * gameballErasureMaxAttempts on the one screen an operator uses to understand
 * why a mandate stopped.
 *
 * Contract: NEVER throws.
 *
 * @param {string} customerId
 * @param {{disposition: string, httpStatus: number, gameballCode: string, requestId: string}} outcome
 * @param {boolean} countAttempt - false when settleRetry already counted the
 *        attempt that exhausted the budget
 * @returns {void}
 */
function settleFailed(customerId, outcome, countAttempt) {
    var key = normaliseKey(customerId) || 'unknown';

    try {
        var row = read(customerId);
        if (!row) {
            return;
        }

        var attempts = readAttempts(row) + (countAttempt === false ? 0 : 1);
        var details = buildStatusDetails(outcome);
        var now = new Date();

        Transaction.wrap(function () {
            row.custom.gbStatus = STATUS_FAILED;
            row.custom.gbLastAttemptAt = now;
            row.custom.gbAttempts = attempts;
            row.custom.gbStatusDetails = details;
        });

        // Ungated (H28): this is the sound a lost erasure mandate makes, and it
        // has a hard deadline - platform retention removes the row 14 days
        // after it was created, and with it the only record that the request
        // ever existed.
        Logger.error('erasureStore~settleFailed: erasure of {0} FAILED after {1} attempt(s) and will not be retried - resolve it before platform retention removes the row: {2}',
            key, attempts, details);
    } catch (e) {
        Logger.error('erasureStore~settleFailed: could not record a failure for {0}: {1}', key, e && e.message);
    }
}

/**
 * Removes one settled row, re-asserting that it is still safe to remove.
 *
 * A separate function rather than an inline block inside purgeSettled's loop so
 * the Transaction.wrap callback does not close over a loop variable - the wrap
 * runs synchronously so it would be correct either way, but a closure created
 * in a loop is the shape a reader has to stop and verify, and this file is read
 * by people auditing a GDPR path.
 *
 * @param {string} key
 * @param {Date} cutoff
 * @returns {boolean} true when the row was removed
 */
function removeSettledRow(key, cutoff) {
    var row = read(key);

    // Re-asserted after the re-fetch (P7), and not only because search can
    // return NULL-valued documents: the row may have been re-armed by a fresh
    // erasure request between the query and this line, and deleting a re-armed
    // mandate would silently drop it.
    var completedAt = readAttr(row, 'gbCompletedAt');
    if (!row || readStatus(row) !== STATUS_SUCCESS || !completedAt || completedAt.getTime() >= cutoff.getTime()) {
        return false;
    }

    Transaction.wrap(function () {
        CustomObjectMgr.remove(row);
    });

    return true;
}

/**
 * Deletes SUCCESS rows completed more than retentionDays ago.
 *
 * These rows hold a pseudonymous identifier that the erasure request existed to
 * remove, so they are purged well inside the type's own 14-day
 * <retention-days> rather than being left to it. Platform retention is the
 * backstop, not the policy - and it is a backstop with a known cost, because it
 * also sweeps FAILED rows, which is documented as a hard operator deadline in
 * docs/gameball-gdpr.md rather than quietly relied on.
 *
 * Keys are collected into a bounded array and the iterator is CLOSED before a
 * single row is removed (P4). Removing rows out of a result set the iterator is
 * still walking is the same hazard readPendingKeys avoids, with a worse failure
 * mode: a half-walked delete.
 *
 * Contract: NEVER throws.
 *
 * @param {number} retentionDays
 * @returns {number} rows removed
 */
function purgeSettled(retentionDays) {
    var cutoff = new Date(Date.now() - (retentionDays * MS_PER_DAY));
    var keys = [];
    var iterator = null;
    var removed = 0;

    try {
        iterator = CustomObjectMgr.queryCustomObjects(
            CO_TYPE,
            'custom.gbStatus = {0} AND custom.gbCompletedAt < {1}',
            null,
            STATUS_SUCCESS,
            cutoff
        );

        while (iterator.hasNext() && keys.length < MAX_PURGE_ROWS) {
            // next() outside the guard: see countFailed.
            var row = iterator.next();

            try {
                var key = normaliseKey(readAttr(row, 'gbCustomerId'));
                if (key) {
                    keys.push(key);
                }
            } catch (rowError) {
                Logger.error('erasureStore~purgeSettled: skipped an unreadable row: {0}', rowError && rowError.message);
            }
        }
    } catch (e) {
        Logger.error('erasureStore~purgeSettled: query failed: {0}', e && e.message);
    } finally {
        if (iterator) {
            try {
                iterator.close();
            } catch (closeError) {
                // See readPendingKeys: an iterator that will not close is not a
                // reason to abandon the pass.
            }
        }
    }

    for (var i = 0; i < keys.length; i++) {
        // Per-row try/catch and one Transaction.wrap per row (H19): a single
        // row that will not delete must not roll back the rows already purged
        // alongside it.
        try {
            if (removeSettledRow(keys[i], cutoff)) {
                removed++;
            }
        } catch (removeError) {
            Logger.error('erasureStore~purgeSettled: could not remove {0}: {1}', keys[i], removeError && removeError.message);
        }
    }

    return removed;
}

module.exports = {
    enrol: enrol,
    read: read,
    hasRequest: hasRequest,
    readDrainState: readDrainState,
    countFailed: countFailed,
    readPendingKeys: readPendingKeys,
    settleSuccess: settleSuccess,
    settleRetry: settleRetry,
    settleFailed: settleFailed,
    purgeSettled: purgeSettled
};
