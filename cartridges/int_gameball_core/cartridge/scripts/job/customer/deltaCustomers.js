'use strict';

// NOTE the absence of module-level requires. A job step module resolves
// nothing at load time (J8, the deliberate inverse of H2): the step type is
// registered at cartridge-load time, and a cartridge module that throws while
// being resolved then takes down step registration rather than one job run.
// Everything is required inside execute() and held in the module-scope
// handles below, so the per-profile callback does not re-resolve a module
// twenty thousand times.

// Tied to the step's declared timeout-in-seconds of 3600. Deliberately well
// under it: a step killed by the platform timeout writes no run summary and no
// cursor, so the next run repeats everything it had already done. Stopping
// ourselves ten minutes early buys a clean, recorded exit.
var MAX_RUN_MS = 50 * 60 * 1000;

// searchProfiles returns at most 1000 hits, so a page cannot usefully be
// larger. Paging on customerNo with a '>=' cursor re-reads exactly one
// already-processed row per page; handleProfile is idempotent, so that costs
// one hash comparison.
var PAGE_SIZE = 1000;

// The cursor value that means "start at the beginning of the customer base".
// NOT the empty string: '0' is what the Yotpo LINK cartridge seeds its
// identically-shaped 'orderNo >= {0}' / 'customerNo >= {0}' page cursor with in
// production (backfillLoyaltyCustomers.js:22, consumed by
// exportLoyaltyCustomerModel.js:44), whereas the behaviour of '>= ""' in the
// SFCC query language is documented nowhere. If '' matched no rows, the very
// first paged run would read zero profiles, take the short-page branch, wrap
// immediately and report a healthy green run that synced nothing - the exact
// symptomless failure this fallback strategy exists to prevent. '0' sorts below
// every digit and every letter, so it selects the whole base under any customer
// numbering scheme SFCC generates.
var CURSOR_START = '0';

var PROGRESS_LOG_EVERY = 500;

var STRATEGY_LAST_MODIFIED = 'LAST_MODIFIED';
var STRATEGY_PAGED_CUSTOMER_NO = 'PAGED_CUSTOMER_NO';

var SOURCE_DELTA_JOB = 'DELTA_JOB';
var SYNC_STATE_SYNCED = 'SYNCED';

var STEP_NAME = 'deltaCustomers~execute';

var MS_PER_HOUR = 3600000;

// Module handles, resolved once per run in execute() (J7/J8).
var Logger = null;
var customerApi = null;
var customerPayload = null;
var gameballPayloadHash = null;
var pacer = null;
var customerSyncGate = null;

// Per-run state, every field reset by resetRun(). Module scope rather than
// closure scope because the profile callback, the two scanners and the summary
// writer are separate functions that all read the same counters.
var infoOn = true;
var windowStartMs = 0;
var startedAtMs = 0;
var callBudget = 0;
var readBudget = 0;
var readBudgetApplies = false;
var readCount = 0;
var unchangedCount = 0;
var sentCount = 0;
var failedCount = 0;
var skippedCount = 0;
var governedCount = 0;
var stopped = false;
var stopReason = '';
var aborted = false;
var cursor = CURSOR_START;

/**
 * Reads one boolean site preference, defaulting rather than failing.
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
 * Clamping here costs one function and cannot break an import.
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
 * Null/exception-safe read of a profile's last-modified timestamp.
 *
 * PersistentObject#getLastModified() is confirmed present in the vendored SFCC
 * API surface, unlike lastModified as a QUERYABLE search field, which is not.
 * That asymmetry is the whole reason this read exists as a re-assertion rather
 * than being left to the query: whichever strategy found the profile, the
 * window is enforced here, in code, against a getter that is known to work.
 *
 * @param {dw.customer.Profile} profile
 * @returns {Date|null}
 */
function getLastModified(profile) {
    try {
        if (typeof profile.getLastModified !== 'function') {
            return null;
        }

        return profile.getLastModified() || null;
    } catch (e) {
        return null;
    }
}

/**
 * Null/exception-safe read of a profile's customer number.
 * @param {dw.customer.Profile} profile
 * @returns {string} '' when absent or unreadable
 */
function readCustomerNo(profile) {
    try {
        return (profile && profile.customerNo) || '';
    } catch (e) {
        return '';
    }
}

/**
 * Null/exception-safe read of the last hash Gameball accepted for a profile.
 * @param {dw.customer.Profile} profile
 * @returns {string} '' when absent, unreadable, or the metadata is not imported
 */
function readSyncHash(profile) {
    try {
        var value = profile && profile.custom && profile.custom.gbSyncHash;
        return value === null || value === undefined ? '' : String(value);
    } catch (e) {
        return '';
    }
}

/**
 * Is this profile's payload identical to the one Gameball last accepted?
 *
 * @param {dw.customer.Profile} profile
 * @returns {boolean} true only when a stored hash matches a freshly computed
 *          one. Any failure answers false, so the profile is sent - a broken
 *          check must cost quota, never coverage.
 */
function isUnchanged(profile) {
    try {
        var stored = readSyncHash(profile);
        if (!stored) {
            // Never synced. Skip the payload build and the digest entirely -
            // the answer cannot be "unchanged" without something to compare to.
            return false;
        }

        var hash = gameballPayloadHash.of(customerPayload.build(profile));
        return !!hash && hash === stored;
    } catch (e) {
        return false;
    }
}

/**
 * Will sendProfile actually issue a Gameball call for this profile?
 *
 * An ADVISORY pre-filter, and the reason it exists is the per-run call budget:
 * that budget must count REAL calls. The obvious shape - acquire a budget unit,
 * then leave the decision to sendProfile - starves the feature outright. In
 * steady state almost every profile inside the lookback window is either
 * unchanged or gated, so a 500-call budget would be consumed by the first 500
 * such profiles the scan happened to reach, every single run, and the changed
 * minority beyond them would never be sent at all. That is not a slow sync; it
 * is a permanently stuck one, and it would look healthy in the log.
 *
 * The alternative considered and rejected was refunding an unused unit to the
 * pacer, which would mean changing a surface three later items are already
 * written against.
 *
 * Both checks are duplicated from gameballCustomerApi.sendProfile, which
 * remains authoritative: it re-runs the gate and the hash comparison and
 * refuses to send if either says no, so this can never cause a call that should
 * not happen. A disagreement in the other direction - this says "no call",
 * sendProfile makes one - costs exactly one unbudgeted call and requires a
 * non-deterministic digest to occur at all.
 *
 * The cost is one gate evaluation, one payload build and one digest per
 * in-window profile: pure CPU, inside a step with a 3600-second timeout, and
 * the gate is evaluated first so a gated profile pays none of the rest.
 *
 * @param {dw.customer.Profile} profile
 * @returns {boolean}
 */
function willIssueCall(profile) {
    try {
        return customerSyncGate.evaluate(profile, SOURCE_DELTA_JOB).shouldSync && !isUnchanged(profile);
    } catch (e) {
        // Fail toward acquiring a unit: an unbudgeted call is a quota problem,
        // an unacquired one is a correctness problem.
        return true;
    }
}

/**
 * Ends the sweep for the rest of this run.
 * @param {string} reason - recorded in the run summary
 */
function stopRun(reason) {
    stopped = true;
    stopReason = reason;
}

/**
 * Processes one profile: re-asserts every query predicate, then syncs it if it
 * has genuinely changed.
 *
 * EVERY guard asserted in the query is re-asserted here because SFCC search
 * "may match and return documents with missing (NULL) values in search fields"
 * (P7) - NULL semantics in the search index are not SQL's. Re-asserting the
 * window in code is also what gives the PAGED_CUSTOMER_NO strategy the same
 * anti-backfill guarantee as LAST_MODIFIED, since that strategy's query does
 * not filter on the window at all.
 *
 * The whole body is caught (H19): one profile that throws must not truncate a
 * twenty-thousand-row sweep, which is exactly what an uncaught throw inside a
 * processProfiles callback would do.
 *
 * @param {dw.customer.Profile} profile
 */
function handleProfile(profile) {
    try {
        if (!profile) {
            return;
        }

        readCount++;
        if (infoOn && readCount % PROGRESS_LOG_EVERY === 0) {
            Logger.info('{0} progress: read={1} sent={2} unchanged={3} failed={4} skipped={5}',
                STEP_NAME, readCount, sentCount, unchangedCount, failedCount, skippedCount);
        }

        // processProfiles cannot be broken out of, so once the run has stopped
        // the callback keeps being handed rows and simply declines to act on
        // them. They are still counted, because "the scan saw 40,000 rows and
        // acted on the first 500" is the information an operator needs to size
        // the budget, and a counter that stops moving hides it.
        if (aborted || stopped) {
            return;
        }

        // The two RUN-level budgets are tested before the window re-assertion
        // below, and the order is load-bearing rather than tidy. Both bound how
        // much of the customer base one run may READ, and in the
        // PAGED_CUSTOMER_NO strategy the query filters on nothing but
        // customerNo - so in steady state essentially every row is out of the
        // window and takes the early return further down. Testing the budgets
        // after that return would mean testing them only on the rare in-window
        // row: a 2,000,000-profile base with forty changed profiles would walk
        // the entire base with readCount climbing past the cap and the elapsed
        // time past MAX_RUN_MS without either test ever executing, and the step
        // would be hard-killed at its declared 3600-second timeout with no
        // summary, no cursor and no run marker written - which is exactly the
        // outcome MAX_RUN_MS exists to prevent. The per-run profile cap is a
        // hard stop, not advice.
        //
        // The window re-assertion stays where it is: it gates SENDING, which is
        // a per-profile decision, not a run budget.
        if (readBudgetApplies && readCount >= readBudget) {
            stopRun('read_budget');
            return;
        }

        if (Date.now() - startedAtMs > MAX_RUN_MS) {
            stopRun('wall_clock');
            return;
        }

        var lastModified = getLastModified(profile);
        if (!lastModified || lastModified.getTime() < windowStartMs) {
            skippedCount++;
            return;
        }

        // The pacer is consulted ONLY when a call is genuinely expected. A
        // profile that is unchanged or gated still goes through sendProfile
        // below - that is what records its SKIPPED state and gives an operator
        // the answer to "why did this customer not sync" - but it consumes no
        // budget, because it makes no call.
        if (willIssueCall(profile) && !pacer.tryAcquire()) {
            if (pacer.isHalted()) {
                stopRun(pacer.getHaltReason());
            } else if (pacer.getIssued() >= callBudget) {
                stopRun('call_budget');
            } else {
                // Governed, not stopped. The refusal is temporary: the sweep
                // goes on reading rows, reading costs wall-clock time, and the
                // measured rate falls back under the ceiling on its own. There
                // is no sleep in SFCC (P12), so declining to issue IS the
                // throttle. This profile is picked up by the next run, where
                // its hash still will not match.
                governedCount++;
            }
            return;
        }

        var result = customerApi.sendProfile(profile, SOURCE_DELTA_JOB);

        if (result.configError) {
            // Bad credentials or a disabled Gameball account. Halting is the
            // point: without it, one fixable configuration mistake would mark
            // twenty thousand profiles FAILED, and every one of those writes
            // bumps lastModified and drags the profile back into the next
            // run's window.
            aborted = true;
            pacer.halt('config_error');
            stopRun('config_error');
            return;
        }

        if (result.sent) {
            if (result.state === SYNC_STATE_SYNCED) {
                sentCount++;
            } else {
                failedCount++;
            }

            if (result.httpStatus === 429) {
                // One 429 means the ACCOUNT is over its ceiling right now -
                // shared with every other site and the storefront - so the
                // whole run stops issuing calls rather than backing off
                // per-profile. The cursor and the counters are intact, so the
                // next run resumes cleanly.
                pacer.halt('rate_limited');
            }
        } else if (result.reason === 'hash_unchanged') {
            // No call, no attribute write, and therefore no bump to
            // lastModified - which is what stops the sweep feeding itself.
            unchangedCount++;
        } else if (result.reason === 'exception' || result.reason === 'no_customer_id') {
            // NOT a gating rule, and the difference matters more than it looks.
            // sendProfile returns reason='exception' from its own boundary
            // catch, which is what a deleted gameball.http.api service or an
            // unimportable module produces on EVERY profile. Counting those as
            // skipped writes 'read=400 sent=0 failed=0 skipped=400' - a total
            // outage rendered as a clean run in which nothing needed doing, on
            // the only run-outcome surface this item ships. no_customer_id is
            // the same shape: the payload builder produced no upsert key, which
            // is a defect, not a policy.
            failedCount++;
        } else {
            // A gating rule stopped it: this entry point disabled, no customer
            // number, or no email while gameballCustomerRequireEmail is on.
            // sendProfile has recorded SKIPPED on the profile, once, so an
            // operator can see which rule and the sweep does not rewrite it on
            // every run.
            skippedCount++;
        }
    } catch (e) {
        failedCount++;
        Logger.error('{0} failed on profile {1}: {2}', STEP_NAME, readCustomerNo(profile) || 'unknown', e && e.message);
    }
}

/**
 * LAST_MODIFIED strategy: ask the search index for the changed profiles.
 *
 * processProfiles rather than searchProfiles because searchProfiles caps at
 * 1000 hits and a day's worth of profile edits at a busy merchant exceeds that
 * (P6). No sort order is passed: processProfiles' acceptance of one is
 * unverified, and this strategy needs none - the whole matched set is walked in
 * a single run, so there is no cursor and nothing that could depend on order.
 *
 * Crucially, nothing here sorts on lastModified, the field this job's own
 * writes mutate. Sorting on a field you mutate is the cursor trap: rows jump
 * ahead of an ascending cursor as you write them, producing both skips and
 * re-reads, and on a large base the sweep never converges.
 *
 * @throws {Error} when lastModified is not a queryable Profile attribute on
 *         this instance. Deliberately propagated to execute(), which turns it
 *         into Status.ERROR naming the preference that fixes it.
 */
function scanLastModified() {
    var CustomerMgr = require('dw/customer/CustomerMgr');
    CustomerMgr.processProfiles(handleProfile, 'lastModified >= {0}', new Date(windowStartMs));
}

/**
 * PAGED_CUSTOMER_NO strategy: page the customer base in customerNo order and
 * filter by last-modified date in code.
 *
 * The fallback for an instance where lastModified is not queryable. This is a
 * READ scan over the whole base, not a backfill: every send is gated by the
 * window re-assertion in handleProfile and by the install floor, which is
 * seeded to "now" on the first run. Three guards keep it that way and none is
 * optional - the floor re-assertion, the read budget, and the call budget.
 *
 * The predicate, the sort and the '0' seed are the exact trio shipped in
 * production by the Yotpo LINK cartridge (exportLoyaltyOrderModel.js:91 on
 * orderNo; backfillLoyaltyCustomers.js:22 for the seed). customerNo ASC is a
 * STRING sort; SFCC customer numbers are zero-padded fixed width by default so
 * string order equals numeric order, and even under a merchant's
 * variable-width scheme a total order is all a cursor needs.
 *
 * The query is re-issued per page rather than one iterator being held open
 * across our own writes (P4). Note this is safe against the cursor trap for a
 * second reason too: we sort on customerNo, which this cartridge never writes,
 * so a profile we just mutated cannot jump the cursor.
 *
 * @param {string} startCursor - the customerNo to resume from, or '' to start
 *        at the beginning of the customer base
 * @param {Function} persistCursor - receives the cursor after each page, and
 *        again when the run stops part-way through one
 */
function scanPagedByCustomerNo(startCursor, persistCursor) {
    var CustomerMgr = require('dw/customer/CustomerMgr');

    cursor = startCursor || CURSOR_START;

    while (!stopped && !aborted) {
        var iterator = CustomerMgr.searchProfiles('customerNo >= {0}', 'customerNo ASC', cursor);
        var rows = 0;
        var lastSeen = cursor;

        try {
            while (iterator.hasNext() && !stopped && !aborted) {
                var profile = iterator.next();
                rows++;

                var customerNo = readCustomerNo(profile);
                if (customerNo) {
                    lastSeen = customerNo;
                }

                handleProfile(profile);
            }
        } finally {
            try {
                iterator.close();
            } catch (e) {
                // A SeekableIterator that will not close is not a reason to
                // abandon the sweep; the platform reclaims it at step end.
            }
        }

        if (stopped || aborted) {
            // A mid-page stop MUST still record how far the page got. The call
            // budget (500) is smaller than a page (1000), so a catch-up run
            // almost always stops part-way through one - and returning here
            // without persisting would throw that page away. With rows that
            // keep failing it is worse than wasteful: a failed call withholds
            // gbSyncHash by design, so the same first 500 profiles would look
            // changed again next run, consume the whole budget again, and stop
            // again at the same place. The scan would never reach page two, and
            // every customer with a higher customerNo would be silently swept
            // never - behind a green Status.OK.
            //
            // aborted is the deliberate exception: a CONFIG failure means the
            // run's verdict on every row it touched is worthless, so the cursor
            // stays put and the next run re-covers the same ground. Re-reading
            // is free - handleProfile is idempotent and an unchanged profile
            // costs one hash comparison.
            if (!aborted && lastSeen !== cursor) {
                cursor = lastSeen;
                persistCursor(cursor);
            }

            return;
        }

        if (rows < PAGE_SIZE) {
            // A short page means the end of the base. Reset so the next run
            // starts a fresh pass from the beginning rather than sitting
            // forever on the highest customerNo.
            cursor = CURSOR_START;
            persistCursor(cursor);
            stopRun('wrapped');
            return;
        }

        if (lastSeen === cursor) {
            // A full page that did not advance the cursor would loop forever.
            // Only reachable if a page of 1000 profiles all had an unreadable
            // customerNo, which should be impossible - which is exactly why it
            // gets an explicit exit rather than a comment saying it cannot
            // happen.
            stopRun('cursor_stalled');
            return;
        }

        cursor = lastSeen;
        persistCursor(cursor);
    }
}

/**
 * @returns {string} the one-line run summary, written both to the log and to
 *          GameballJobState.gbCustomerDeltaLastRunSummary so an operator can
 *          read the last run's outcome without going to the log file
 */
function buildSummary() {
    return 'read=' + readCount
        + ' unchanged=' + unchangedCount
        + ' sent=' + sentCount
        + ' failed=' + failedCount
        + ' skipped=' + skippedCount
        + ' governed=' + governedCount
        + ' calls=' + pacer.getIssued()
        + ' ms=' + pacer.getElapsedMs()
        + ' end=' + (stopReason || 'exhausted');
}

/**
 * Resets every per-run counter. Module state survives between runs in the same
 * JVM, so a field left unreset would carry one run's numbers into the next.
 */
function resetRun() {
    readCount = 0;
    unchangedCount = 0;
    sentCount = 0;
    failedCount = 0;
    skippedCount = 0;
    governedCount = 0;
    stopped = false;
    stopReason = '';
    aborted = false;
    cursor = CURSOR_START;
    startedAtMs = Date.now();
}

/**
 * Sweeps customer profiles modified since the last Gameball sync and upserts
 * the changed ones.
 *
 * This is the coverage floor for every entry point SFCC gives no hook for at
 * all - a Business Manager agent editing a profile, and a customer import job -
 * and it is simultaneously the retry path for any inline sync that failed,
 * because a failed call withholds gbSyncHash and the profile therefore still
 * looks changed on the next sweep. There is no queue and no attempt ladder;
 * retry stops on its own when a profile falls out of the lookback window.
 *
 * Neither argument is read: the step declares zero parameters and takes
 * everything from site preferences (J5). They are in the signature because the
 * platform's task-step contract supplies them.
 *
 * @param {Object} parameters - job step parameters (none declared)
 * @param {dw.job.JobStepExecution} stepExecution - job step execution
 * @returns {dw.system.Status} ERROR only on a configuration-class failure; OK
 *          when individual profiles failed, because those retry on the next run
 *          by design and a handful of retryable rows is the normal, self-healing
 *          state - turning the job red every hour for it would train an
 *          operator to ignore it
 */
function execute(parameters, stepExecution) { // eslint-disable-line no-unused-vars
    var Status = require('dw/system/Status');
    Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.job');

    try {
        var System = require('dw/system/System');
        var Site = require('dw/system/Site');
        var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
        var gameballJobState = require('*/cartridge/scripts/job/gameballJobState');

        customerApi = require('*/cartridge/scripts/api/gameballCustomerApi');
        customerPayload = require('*/cartridge/models/payload/customerPayload');
        gameballPayloadHash = require('*/cartridge/scripts/util/gameballPayloadHash');
        pacer = require('*/cartridge/scripts/job/gameballJobPacer');
        customerSyncGate = require('*/cartridge/scripts/customer/customerSyncGate');

        // Logging policy for this step, stated once. gameballInfoLogEnabled
        // gates the PROGRESS line and nothing else, because that is the only
        // line whose volume scales with the customer base (one per 500 rows).
        // The start line, the finish summary and the three guard lines are
        // ungated: they fire at most once per run, and they are the only
        // explanation a merchant gets for a run that did nothing. Gating them
        // would produce a job that reports success with no output at all,
        // which is indistinguishable from a job that is silently broken.
        infoOn = readBooleanPreference('gameballInfoLogEnabled', true);

        // Guard 1, first thing that runs. A sandbox data refresh copies
        // production customer data; without this a refreshed sandbox starts
        // pushing production customers into the live Gameball workspace
        // unattended within one schedule interval. Status.OK rather than ERROR
        // because a non-Production instance correctly declining to run is
        // expected behaviour, not a failure anyone should be paged for.
        if (System.getInstanceType() !== System.PRODUCTION_SYSTEM
                && !readBooleanPreference('gameballAllowNonProductionSync', false)) {
            Logger.warn('{0} refused to run: this is not a Production instance and gameballAllowNonProductionSync is off',
                STEP_NAME);
            return new Status(Status.OK);
        }

        // Guards 2 and 3 in one predicate (H37), because no caller may ever
        // enable-check half the condition. The diagnostic read below happens
        // AFTER the decision and only to name which half is missing - a job
        // that logs "skipped" with no reason is a support ticket.
        if (!customerSyncGate.isEnabled()) {
            // The diagnostic read goes through the same guarded helper as every
            // other preference read in this file rather than dereferencing
            // Site.getCurrent() inline: a job step declares
            // @supports-site-context true so a site is expected, but a line
            // whose only job is to explain why the step declined must not be
            // the line that converts a clean OK into a step-level ERROR.
            Logger.info('{0} skipped: gameballEnabled={1}, gameball.http.api.cred configured={2}',
                STEP_NAME,
                readBooleanPreference('gameballEnabled', false),
                gameballCredentials.isConfigured());
            return new Status(Status.OK);
        }

        var state = gameballJobState.get();

        // The anti-backfill mechanism, and the reason the first run is a no-op.
        // Every subsequent run discards any profile modified before this
        // instant, in the query for LAST_MODIFIED and in code for both
        // strategies. A merchant who genuinely wants a bounded catch-up
        // backdates this one datetime in Business Manager, consciously, with
        // the call budget still throttling it. There is no backfill job, no
        // backfill cursor and no backfill preference, by decision.
        if (!state.custom.gbCustomerDeltaFloor) {
            var Transaction = require('dw/system/Transaction');
            var seededAt = new Date();
            Transaction.wrap(function () {
                state.custom.gbCustomerDeltaFloor = seededAt;
            });

            Logger.info('{0}: Gameball customer delta floor seeded at {1}; first run syncs nothing by design',
                STEP_NAME, seededAt.toISOString());
            return new Status(Status.OK);
        }

        var lookbackHours = readIntPreference('gameballCustomerDeltaLookbackHours', 48, 1);
        var floorMs = state.custom.gbCustomerDeltaFloor.getTime();
        var lookbackMs = Date.now() - (lookbackHours * MS_PER_HOUR);

        // A rolling window bounded below by the install floor - never a
        // self-advancing watermark. gbCustomerDeltaLastRunAt is written for
        // humans and is never a query predicate: the customer search index is
        // asynchronous, so a watermark used as a filter silently loses every
        // profile the index had not yet published when the previous run ended.
        windowStartMs = floorMs > lookbackMs ? floorMs : lookbackMs;

        callBudget = readIntPreference('gameballCustomerDeltaMaxCallsPerRun', 500, 1);
        readBudget = readIntPreference('gameballCustomerDeltaMaxProfilesPerRun', 20000, 1);

        var site = Site.getCurrent();
        var strategy = site ? site.getCustomPreferenceValue('gameballCustomerDeltaStrategy') : null;
        var usePaged = String(strategy || STRATEGY_LAST_MODIFIED) === STRATEGY_PAGED_CUSTOMER_NO;

        // The read budget is the paged strategy's only termination guarantee -
        // it is what bounds how much of the customer base one run walks. The
        // LAST_MODIFIED strategy is already bounded by its own query, so
        // applying the budget there would truncate a legitimate window for no
        // safety gain.
        readBudgetApplies = usePaged;

        resetRun();
        pacer.start(callBudget, readIntPreference('gameballMaxRequestsPerSecond', 10, 1));

        Logger.info('{0} starting: strategy={1} windowStart={2} callBudget={3} readBudget={4}',
            STEP_NAME, usePaged ? STRATEGY_PAGED_CUSTOMER_NO : STRATEGY_LAST_MODIFIED,
            new Date(windowStartMs).toISOString(), callBudget, usePaged ? readBudget : 'n/a');

        if (usePaged) {
            scanPagedByCustomerNo(String(state.custom.gbCustomerDeltaCursor || ''), function (value) {
                gameballJobState.update(function (row) {
                    row.custom.gbCustomerDeltaCursor = value;
                });
            });
        } else {
            try {
                scanLastModified();
            } catch (scanError) {
                var remedy = 'Gameball customer delta LAST_MODIFIED scan failed - lastModified may not be queryable on Profile on this instance; set gameballCustomerDeltaStrategy to PAGED_CUSTOMER_NO. '
                    + (scanError && scanError.message);
                Logger.error('{0}: {1}', STEP_NAME, remedy);

                // Deliberately NOT an automatic fallback to PAGED_CUSTOMER_NO.
                // That fallback scans the entire customer base, so falling back
                // silently would convert a configuration problem into exactly
                // the backfill this item is forbidden to perform. The remedy is
                // named in the status message instead, and a human flips the
                // preference.
                return new Status(Status.ERROR, remedy);
            }
        }

        var summary = buildSummary();
        gameballJobState.update(function (row) {
            row.custom.gbCustomerDeltaLastRunAt = new Date();
            row.custom.gbCustomerDeltaLastRunSummary = summary;
        });

        Logger.info('{0} finished: {1}', STEP_NAME, summary);

        if (aborted) {
            return new Status(Status.ERROR, 'Gameball customer delta aborted on a configuration error: ' + summary);
        }

        return new Status(Status.OK);
    } catch (e) {
        Logger.error('{0} failed: {1}', STEP_NAME, e && e.message);
        return new Status(Status.ERROR, 'Gameball customer delta failed: ' + (e && e.message));
    }
}

module.exports = {
    execute: execute
};
