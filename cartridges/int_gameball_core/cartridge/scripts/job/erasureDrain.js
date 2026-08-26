'use strict';

// NOTE the absence of module-level requires, matching deltaCustomers.js. A job
// step module resolves nothing at load time (J8, the deliberate inverse of H2):
// the step type is registered at cartridge-load time, and a cartridge module
// that throws while being resolved takes down step registration rather than one
// job run. Everything is required inside execute() and held in the module-scope
// handles below.

// Hard cap on rows drained in one run, passed to the shared pacer as this
// step's per-run call budget. A backlog larger than this drains across
// successive 30-minute runs, oldest request first, which is the correct
// behaviour for a queue whose steady-state depth is zero to a handful of rows.
var MAX_ROWS_PER_RUN = 500;

// Fallbacks used when a preference has not been imported yet. They are the same
// values the metadata declares as <default-value>, duplicated here on purpose:
// getCustomPreferenceValue returns null for an id that has not been imported,
// so without a code-side fallback a code-then-metadata release would run this
// job with a retry ceiling of zero and settle every row FAILED on its first
// pass.
var DEFAULT_MAX_ATTEMPTS = 5;
var DEFAULT_SUCCESS_RETENTION_DAYS = 7;
var DEFAULT_MAX_RPS = 10;

// Wall-clock backstop on a PENDING row, in days, and the one bound that does
// not depend on the attempt budget. It exists because an attempt refused by
// SFCC itself deliberately does not count (S26): with the service disabled in
// Business Manager, or a circuit breaker that never closes, every call comes
// back SERVICE_UNAVAILABLE, gbAttempts stays 0, the row stays PENDING and the
// run stays green - for all 672 runs of the fortnight, at which point the
// type's own 14-day retention destroys the tombstone and the mandate is gone
// with no signal anywhere. Half the retention window gives an operator seven
// red days to act before that happens. Keeping the budget unburned is right;
// letting the run stay silent is not.
var STALE_PENDING_DAYS = 7;

var MS_PER_DAY = 86400000;

// The one status value this step names. erasureStore owns the vocabulary and
// every write of it; this is the single read-side comparison, and it is a named
// constant rather than an inline literal so a grep for the state machine finds
// this file too.
var STATUS_PENDING = 'PENDING';

var STEP_NAME = 'erasureDrain~execute';

// Module handles, resolved once per run in execute() (J7/J8).
var Logger = null;
var erasureStore = null;
var privacyApi = null;
var pacer = null;
var DISPOSITION = null;

// Per-run state, every field reset by resetRun(). Module scope survives between
// runs in the same JVM, so a field left unreset would carry one run's numbers
// into the next.
var scannedCount = 0;
var successCount = 0;
var retryCount = 0;
var failedCount = 0;
var purgedCount = 0;
var abandonedCount = 0;
var attemptedCount = 0;
var unavailableCount = 0;
var bareNotFoundCount = 0;
var standingFailedCount = 0;
var stopReason = '';
var configMessage = '';

/**
 * Reads one boolean site preference, defaulting rather than failing.
 *
 * getCustomPreferenceValue returns null for an id that has not been imported -
 * it does not throw - so "not imported yet" and "the operator set it to No"
 * must not collapse into the same answer. For this step that distinction is
 * load-bearing in one direction only: gameballErasureEnabled defaults to false,
 * so a missing preference correctly means "do not hard-delete anybody".
 *
 * @param {string} id
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readBooleanPreference(id, fallback) {
    try {
        var site = require('dw/system/Site').getCurrent();
        if (!site) {
            return fallback;
        }

        var value = site.getCustomPreferenceValue(id);
        return value === null || value === undefined ? fallback : !!value;
    } catch (e) {
        return fallback;
    }
}

/**
 * Reads one integer site preference, clamped and defaulted.
 *
 * Clamped in code rather than with <min-value>/<max-value> in the metadata:
 * whether this XSD version accepts those elements is unverified, and a metadata
 * file that fails to import takes the merchant's entire site import with it.
 *
 * @param {string} id
 * @param {number} fallback - used when absent, unreadable, or below minimum
 * @param {number} minimum
 * @returns {number}
 */
function readIntPreference(id, fallback, minimum) {
    try {
        var site = require('dw/system/Site').getCurrent();
        if (!site) {
            return fallback;
        }

        var parsed = parseInt(site.getCustomPreferenceValue(id), 10);
        if (isNaN(parsed) || parsed < minimum) {
            return fallback;
        }

        return parsed;
    } catch (e) {
        return fallback;
    }
}

/**
 * Resets every per-run counter.
 * @returns {void}
 */
function resetRun() {
    scannedCount = 0;
    successCount = 0;
    retryCount = 0;
    failedCount = 0;
    purgedCount = 0;
    abandonedCount = 0;
    attemptedCount = 0;
    unavailableCount = 0;
    bareNotFoundCount = 0;
    standingFailedCount = 0;
    stopReason = '';
    configMessage = '';
}

/**
 * @returns {string} the one-line run summary written to the Gameball log. There
 *          is no Business Manager dashboard in this iteration, so this line plus
 *          the step's exit status IS the operator surface.
 */
function buildSummary() {
    return 'scanned=' + scannedCount
        + ' success=' + successCount
        + ' retry=' + retryCount
        + ' failed=' + failedCount
        + ' abandoned=' + abandonedCount
        + ' unavailable=' + unavailableCount
        + ' purged=' + purgedCount
        + ' outstanding=' + standingFailedCount
        + ' calls=' + pacer.getIssued()
        + ' ms=' + pacer.getElapsedMs()
        + ' end=' + (stopReason || 'exhausted');
}

/**
 * Builds the synthetic outcome recorded against a row this step abandons
 * without calling Gameball at all.
 *
 * It is shaped exactly like a real gameballPrivacyApi.deleteCustomer outcome so
 * erasureStore.buildStatusDetails composes the same four-field diagnostic it
 * composes for a real failure - an operator reading gbStatusDetails in Business
 * Manager should not have to learn a second format to find out why a mandate
 * stopped.
 *
 * @param {string} code - the reason, as the code field: at_ceiling | stale
 * @param {string} message
 * @returns {{disposition: string, httpStatus: number, gameballCode: string,
 *            requestId: string, message: string}}
 */
function abandonedOutcome(code, message) {
    return {
        disposition: DISPOSITION.PERMANENT,
        httpStatus: 0,
        gameballCode: code,
        requestId: '',
        message: message
    };
}

/**
 * Turns the run red, saying the same thing twice on purpose.
 *
 * The Status message is what Business Manager job history shows and what the
 * Notification tab mails out; the Logger.error line is what survives in the
 * custom log after the job history entry ages out. With no Business Manager
 * dashboard in this iteration those two ARE the operator surface for a lost
 * legal mandate, so neither is allowed to be the only copy.
 *
 * @param {string} message - the operator-facing diagnosis and remedy
 * @param {string} summary - the run summary line, appended in brackets
 * @returns {dw.system.Status} ERROR
 */
function fail(message, summary) {
    var Status = require('dw/system/Status');
    var line = message + ' [' + summary + ']';

    Logger.error('{0}: {1}', STEP_NAME, line);

    return new Status(Status.ERROR, line);
}

/**
 * Records the outcome of one delete attempt against one row.
 *
 * The dispositions are not symmetric and each asymmetry is deliberate:
 *
 *   SUCCESS / ALREADY_APPLIED - the record is gone, or Gameball never had it.
 *     Scope DELETE maps HTTP 404 and code 7000 here, which also silently and
 *     correctly absorbs the very common case of a shopper who registered while
 *     the integration was switched off and was therefore never synced.
 *   SERVICE_UNAVAILABLE - SFCC's own rate limiter or open circuit. The call
 *     never reached Gameball, so the retry budget is NOT burned (S26). Safe here
 *     in a way it is not for order tracking: a delete is naturally idempotent,
 *     so no verification probe is needed before re-sending - a duplicate delete
 *     returns 404, which is SUCCESS. It is bounded instead by wall clock, in
 *     two places: drain() fails a row still PENDING STALE_PENDING_DAYS after
 *     capture, and execute() turns the whole run red when EVERY call it made
 *     came back this way. An unburned budget must not also mean an unraised
 *     alarm.
 *   TRANSIENT / AMBIGUOUS - the call reached Gameball and did not settle it.
 *     These DO burn the budget, because they represent a real attempt, and
 *     because a mandate that retries forever is a mandate nobody ever notices
 *     has stalled. AMBIGUOUS joins them rather than getting a probe for the same
 *     idempotency reason as above.
 *   PERMANENT - identical bytes will fail identically forever. Usually a
 *     malformed customerId. FAILED immediately; retrying never helps.
 *
 * @param {string} key
 * @param {Object} outcome - as returned by gameballPrivacyApi.deleteCustomer
 * @param {number} maxAttempts
 * @returns {void}
 */
function settleOutcome(key, outcome, maxAttempts) {
    var disposition = outcome.disposition;

    if (disposition === DISPOSITION.SUCCESS || disposition === DISPOSITION.ALREADY_APPLIED) {
        erasureStore.settleSuccess(key, outcome);
        successCount++;
        return;
    }

    if (disposition === DISPOSITION.PERMANENT) {
        erasureStore.settleFailed(key, outcome, true);
        failedCount++;
        return;
    }

    if (disposition === DISPOSITION.SERVICE_UNAVAILABLE) {
        erasureStore.settleRetry(key, outcome, false);
        retryCount++;
        return;
    }

    // TRANSIENT, AMBIGUOUS, and anything the table did not recognise. Falling
    // through to a counted retry is fail-safe rather than fail-silent, and it is
    // self-limiting: the attempt ceiling ends it.
    var attempts = erasureStore.settleRetry(key, outcome, true);

    if (attempts >= maxAttempts) {
        // countAttempt false: settleRetry above already counted the call that
        // exhausted the budget, and counting it twice would make gbAttempts
        // disagree with gameballErasureMaxAttempts on the one screen an
        // operator has.
        erasureStore.settleFailed(key, outcome, false);
        failedCount++;
        return;
    }

    retryCount++;
}

/**
 * Drains one page of tombstones.
 *
 * Keys, not rows: readPendingKeys closed its iterator before returning, because
 * mutating rows inside a result set the iterator is still walking is a
 * documented SFCC hazard (P4).
 *
 * Every row's eligibility is re-asserted here rather than trusted from the page
 * (P7). A row that is gone or already settled is skipped in silence - somebody
 * else got there first, which is the outcome we wanted - and re-checking costs
 * one primary-key read against a call that costs a network round trip.
 *
 * Two of those re-assertions END a mandate without spending a call, and both
 * exist because the alternative is a row that quietly never gets one:
 *
 *   at the ceiling - gbAttempts has reached maxAttempts while the row is still
 *     PENDING. The query no longer filters these out precisely so that they can
 *     be settled here; an operator lowering gameballErasureMaxAttempts, or a
 *     restart between settleRetry and settleFailed, otherwise strands the row
 *     forever with nothing ever reading it again.
 *   stale - the row has been attempted at least once and was captured more than
 *     STALE_PENDING_DAYS ago. This is the only bound on an outcome that never
 *     burns the budget by design, and without it a permanently unavailable
 *     service keeps a mandate PENDING and the job green until retention
 *     destroys it.
 *
 * @param {string[]} keys
 * @param {number} maxAttempts
 * @param {Date} staleCutoff - a PENDING row requested before this was captured
 *        too long ago to still be waiting
 * @returns {void}
 */
function drain(keys, maxAttempts, staleCutoff) {
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];

        // Per-row try/catch (H19): one bad row must not truncate the run and
        // strand every erasure mandate queued behind it.
        try {
            var state = erasureStore.readDrainState(key);

            if (!state || state.status !== STATUS_PENDING) {
                continue;
            }

            if (state.attempts >= maxAttempts) {
                // countAttempt false: no call is being made, so nothing new to
                // count. The row goes FAILED and therefore red rather than
                // sitting PENDING where nothing would ever look at it again.
                erasureStore.settleFailed(key, abandonedOutcome('at_ceiling',
                    'already at the attempt ceiling of ' + maxAttempts + ' while still PENDING'), false);
                failedCount++;
                abandonedCount++;
                continue;
            }

            if (state.lastAttemptAt && state.requestedAt && state.requestedAt.getTime() < staleCutoff.getTime()) {
                // Attempted at least once (so this is not a backlog that was
                // merely waiting for the feature to be switched on) and older
                // than the backstop. The most likely cause by far is a service
                // SFCC will not call - disabled in Business Manager, or a
                // breaker that never closes - which never burns an attempt.
                erasureStore.settleFailed(key, abandonedOutcome('stale',
                    'still PENDING more than ' + STALE_PENDING_DAYS + ' days after capture; Gameball was never reached'), false);
                failedCount++;
                abandonedCount++;
                continue;
            }

            scannedCount++;

            if (!pacer.tryAcquire()) {
                // Unlike the customer sweep there is nothing cheap left to do
                // in this loop - every remaining row costs exactly one call -
                // so a refusal ends the run rather than being counted and
                // walked past. Whether it was a cap, the governor or a halt is
                // reported so an operator can size the schedule.
                if (pacer.isHalted()) {
                    stopReason = pacer.getHaltReason();
                } else if (pacer.getIssued() >= MAX_ROWS_PER_RUN) {
                    stopReason = 'row_budget';
                } else {
                    stopReason = 'rate_governed';
                }

                return;
            }

            var outcome = privacyApi.deleteCustomer(key);
            attemptedCount++;

            if (outcome.disposition === DISPOSITION.SERVICE_UNAVAILABLE) {
                unavailableCount++;
            }

            if (outcome.httpStatus === 404 && !outcome.gameballCode) {
                // A 404 that carried no Gameball envelope at all. One is
                // unremarkable; a whole run of them is the signature of a
                // delete endpoint that is not routed on this account, and the
                // run-level check in execute() turns that into a message naming
                // the fallback rather than a pile of anonymous FAILED rows.
                bareNotFoundCount++;
            }

            if (outcome.disposition === DISPOSITION.CONFIG) {
                // Stop everything, settle nothing, increment nothing. Grinding
                // a bad or rotated key through five hundred queued rows is how
                // a cartridge gets its Gameball account blacklisted, and every
                // one of those rows would come back FAILED for a reason that
                // has nothing to do with the row.
                configMessage = 'Gameball refused the erasure call as a configuration fault (code='
                    + (outcome.gameballCode || outcome.httpStatus) + '): ' + outcome.message
                    + ' - check the gameball.http.api.cred Service Credential.';
                stopReason = 'config_error';
                pacer.halt('config_error');
                return;
            }

            if (outcome.httpStatus === 429) {
                // One 429 means the ACCOUNT is over its ceiling right now -
                // shared with every other site and the storefront - so the run
                // stops issuing calls after settling this row rather than
                // backing off per-row. The remaining rows are still PENDING and
                // the next run resumes cleanly.
                pacer.halt('rate_limited');
            }

            settleOutcome(key, outcome, maxAttempts);
        } catch (rowError) {
            Logger.error('{0}: row {1} failed and was left PENDING: {2}', STEP_NAME, key, rowError && rowError.message);
        }
    }
}

/**
 * custom.Gameball.CustomerErasure - drains captured right-to-be-forgotten
 * tombstones against Gameball's hard-delete endpoint.
 *
 * A TASK step, not a chunk step. A chunk step cannot set a custom exit status,
 * so making a failed erasure go red in Business Manager would need the whole
 * chunk -> continue -> task -> stop-job relay (J12) plus six extra callbacks -
 * real machinery for a queue whose steady-state depth is zero. A task step
 * returns dw.system.Status directly (J4) and MAX_ROWS_PER_RUN gives the same
 * protection against a runaway backlog that chunking would.
 *
 * Neither argument is read: the step declares zero parameters and takes
 * everything from site preferences (J5). They are in the signature because the
 * platform's task-step contract supplies them.
 *
 * @param {Object} parameters - job step parameters (none declared)
 * @param {dw.job.JobStepExecution} stepExecution - job step execution
 * @returns {dw.system.Status} ERROR when the run stopped on a configuration
 *          fault, when every call it made came back the same suspicious way, or
 *          when ANY FAILED row is standing in the store - not merely one that
 *          failed during this run. OK otherwise, including when the feature is
 *          switched off.
 *
 *          The standing-row rule is a deliberate departure from the other
 *          Gameball jobs, which stay green on transient row failures: a handful
 *          of retryable orders is a normal self-healing state, but an erasure
 *          that ran out of retries is a legal mandate that platform retention
 *          will destroy in 14 days unless a human sees it. Counting only this
 *          run's failures would have made it red for exactly one run in that
 *          fortnight, which is indistinguishable from never.
 */
function execute(parameters, stepExecution) { // eslint-disable-line no-unused-vars
    var Status = require('dw/system/Status');
    Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.job');

    try {
        var System = require('dw/system/System');
        var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
        var gameballErrors = require('*/cartridge/scripts/util/gameballErrors');

        erasureStore = require('*/cartridge/scripts/privacy/erasureStore');
        privacyApi = require('*/cartridge/scripts/api/gameballPrivacyApi');
        pacer = require('*/cartridge/scripts/job/gameballJobPacer');
        DISPOSITION = gameballErrors.DISPOSITION;

        // Logging policy for this step, stated once. Nothing here reads
        // gameballInfoLogEnabled, because this step has no per-row info line to
        // gate: it writes exactly three lines - a guard line, a start line and a
        // finish summary - and every one of them fires at most once per run.
        // Gating them would produce a job that reports success with no output at
        // all, which is indistinguishable from a job that is silently broken,
        // and for a GDPR path that is the failure mode with the worst
        // consequences. Per-row detail is at error level, which is never gated.

        // Guard 1, and the most dangerous line in this item. A sandbox data
        // refresh copies production Custom Objects, tombstones included.
        // Without this guard a refreshed sandbox would hard-delete real
        // production customers from the production Gameball workspace within
        // one job interval, unattended, with no undo. Status.OK rather than
        // ERROR because a non-Production instance correctly declining to run is
        // expected behaviour, not a failure anyone should be paged for.
        if (System.getInstanceType() !== System.PRODUCTION_SYSTEM
                && !readBooleanPreference('gameballAllowNonProductionSync', false)) {
            Logger.warn('{0} refused to run: this is not a Production instance and gameballAllowNonProductionSync is off',
                STEP_NAME);
            return new Status(Status.OK);
        }

        // Guard 2. Rows stay PENDING and are drained whenever the merchant
        // turns the switch on, provided that happens inside the 14-day
        // retention window - which is why capture is deliberately ungated and
        // only the drain is.
        if (!readBooleanPreference('gameballErasureEnabled', false)) {
            Logger.info('{0} skipped: gameballErasureEnabled is off; captured erasure requests are retained, not lost', STEP_NAME);
            return new Status(Status.OK);
        }

        // Guard 3. Separated from guard 2 only so the log line can name which
        // half is missing; the two together are the enable predicate (H37).
        if (!gameballCredentials.isConfigured()) {
            Logger.warn('{0} skipped: the gameball.http.api.cred Service Credential has no API Key', STEP_NAME);
            return new Status(Status.OK);
        }

        resetRun();

        var maxAttempts = readIntPreference('gameballErasureMaxAttempts', DEFAULT_MAX_ATTEMPTS, 1);
        var retentionDays = readIntPreference('gameballErasureSuccessRetentionDays', DEFAULT_SUCCESS_RETENTION_DAYS, 1);

        // Purge BEFORE draining, so a large SUCCESS backlog cannot eat the
        // run's wall clock ahead of the mandates that still need serving.
        purgedCount = erasureStore.purgeSettled(retentionDays);

        var keys = erasureStore.readPendingKeys(MAX_ROWS_PER_RUN);

        pacer.start(MAX_ROWS_PER_RUN, readIntPreference('gameballMaxRequestsPerSecond', DEFAULT_MAX_RPS, 1));

        Logger.info('{0} starting: pending={1} maxAttempts={2} purged={3}', STEP_NAME, keys.length, maxAttempts, purgedCount);

        drain(keys, maxAttempts, new Date(Date.now() - (STALE_PENDING_DAYS * MS_PER_DAY)));

        // Counted AFTER the drain so this run's own failures are included, and
        // counted at all because failedCount alone cannot keep the job red: a
        // FAILED row is never read by readPendingKeys again, so a per-run
        // counter goes back to zero on the next pass and an unhonoured mandate
        // sits behind a green job until retention destroys it. -1 means the
        // census itself failed, which must not be read as "none outstanding".
        var standing = erasureStore.countFailed();
        standingFailedCount = standing < 0 ? failedCount : standing;

        var summary = buildSummary();
        Logger.info('{0} finished: {1}', STEP_NAME, summary);

        if (configMessage) {
            return new Status(Status.ERROR, configMessage + ' [' + summary + ']');
        }

        // Ordered most-specific first: each of the three below would otherwise
        // surface as the generic outstanding-mandates line, and the generic line
        // names no cause an operator could act on.
        if (attemptedCount > 0 && bareNotFoundCount === attemptedCount) {
            return fail('Gameball answered every one of the ' + attemptedCount
                + ' erasure call(s) in this run with HTTP 404 and no Gameball error envelope. That is the signature of a delete endpoint that is not routed on this account, NOT of customers who are already gone - do not read these as erased. Verify one deletion in the Gameball dashboard, then switch gameballPrivacyApi.deleteCustomer to the documented DELETE-verb form of integrations/customers/{id}.',
                summary);
        }

        if (attemptedCount > 0 && unavailableCount === attemptedCount) {
            return fail('SFCC refused every one of the ' + attemptedCount
                + ' erasure call(s) in this run before they reached Gameball, so no attempt was counted and every request is still PENDING. Check that the gameball.http.api service is Enabled in Business Manager and that its circuit breaker has closed. Requests older than '
                + STALE_PENDING_DAYS + ' days in this state are marked FAILED rather than left to expire silently.', summary);
        }

        if (standingFailedCount > 0) {
            return fail('Gameball customer erasure: ' + standingFailedCount
                + ' request(s) are FAILED and will NOT be retried automatically. Resolve each one - re-issue it with gameballPrivacyApi.requestErasureById(id, \'BM_MANUAL\') or delete the GameballErasureRequest row once you have confirmed the deletion in the Gameball dashboard. This job stays red until none are left, and platform retention removes each row 14 days after it was captured.',
                summary);
        }

        return new Status(Status.OK);
    } catch (e) {
        Logger.error('{0} failed: {1}', STEP_NAME, e && e.message);
        return new Status(Status.ERROR, 'Gameball customer erasure failed: ' + (e && e.message));
    }
}

module.exports = {
    execute: execute
};
