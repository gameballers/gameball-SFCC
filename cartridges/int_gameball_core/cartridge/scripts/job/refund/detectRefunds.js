'use strict';

// NOTE the absence of module-level requires, matching deltaCustomers.js,
// erasureDrain.js and retryFailedOrders.js. A job step module resolves
// nothing at load time (J8, the deliberate inverse of H2): the step type is
// registered at cartridge-load time, and a cartridge module that throws
// while being resolved takes down step registration rather than one job
// run. Everything is required inside execute() and held in the module-scope
// handles below. (Standards J8's own text reserves this pattern for CHUNK
// steps and expects a task step like this one to use top-level requires;
// every task step actually shipped in this cartridge - items 03, 04 and 06 -
// deviates from that for the reason above, so this item follows the
// established precedent rather than the unweighted default.)

// Hard cap on outbound Gameball calls (POST refund, in both passes) issued
// in one run - passed to the shared pacer as this step's per-run call
// budget. Deliberately a CODE CONSTANT, not a site preference: unlike the
// other three jobs' per-run caps, a merchant has no basis on which to tune
// this one, and it exists purely as a blast-radius guard for the first run
// after a long outage (build-plan section 7.2's own reasoning for the
// figure). Remaining candidates keep their PENDING entries and drain across
// subsequent hourly runs.
var MAX_SENDS_PER_RUN = 500;

var STEP_NAME = 'detectRefunds~execute';

// Module handles, resolved once per run in execute() (J7/J8).
var Logger = null;
var OrderMgr = null;
var Order = null;
var refundStateStore = null;
var refundDelivery = null;
var pacer = null;

// Per-run configuration, re-read by readConfig() at the top of every run
// (J7) - never assumed unchanged between runs in the same JVM.
var detectCancellations = true;
var lookbackDays = 90;
var orphanMaxHours = 24;
var lookbackStart = null;

// Per-run counters, aggregate state and halt flags. Every field reset by
// resetRun().
var scannedA = 0;
var detectedA = 0;
var scannedB = 0;
var deliveredCount = 0;
var duplicateCount = 0;
var pendingCount = 0;
var manualReviewCount = 0;
var failedCount = 0;
var skippedCount = 0;
var configHalted = false;
var configMessage = '';
var sweepError = null;

// Order numbers Pass A already touched this run, so Pass B's
// gbRefundPendingAt sweep - which is a fresh index query and therefore
// cannot see writes Pass A itself just made within the same run - never
// attempts the same order twice (section 5.2 step 13).
var touchedInPassA = {};

/**
 * Reads one boolean site preference, defaulting rather than failing.
 * Mirrors the identical helper in retryFailedOrders.js/erasureDrain.js -
 * duplicated per file rather than shared, matching this cartridge's
 * established job-module convention (each job step module is a
 * self-contained, independently loadable unit per J8).
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
 * Reads one integer site preference, clamped on both ends and defaulted.
 * Clamped in code rather than with <min-value>/<max-value> in the metadata
 * (arbitration section 2.8 rule 5 - whether this XSD version accepts those
 * elements is unverified, and a metadata file that fails to import takes
 * the merchant's whole site import with it).
 * @param {string} id
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function readIntPreference(id, fallback, minimum, maximum) {
    try {
        var site = require('dw/system/Site').getCurrent();
        if (!site) {
            return fallback;
        }

        var parsed = parseInt(site.getCustomPreferenceValue(id), 10);
        if (isNaN(parsed) || parsed < minimum || parsed > maximum) {
            return fallback;
        }

        return parsed;
    } catch (e) {
        return fallback;
    }
}

/**
 * @returns {{detectCancellations: boolean, lookbackDays: number,
 *            orphanMaxHours: number, maxRequestsPerSecond: number}}
 */
function readConfig() {
    return {
        detectCancellations: readBooleanPreference('gameballRefundDetectCancellations', true),
        lookbackDays: readIntPreference('gameballRefundLookbackDays', 90, 1, 3650),
        orphanMaxHours: readIntPreference('gameballRefundOrphanMaxHours', 24, 1, 720),
        // Not this item's preference (arbitration section 2.2, C-6: moved to
        // item 03 because the 360-per-30s ceiling is account-scoped and
        // shared by every job plus the storefront) - only read and clamped
        // here, never declared in this item's metadata section.
        maxRequestsPerSecond: readIntPreference('gameballMaxRequestsPerSecond', 10, 1, 30)
    };
}

/**
 * Resets every per-run counter, halt flag and the Pass-A/Pass-B dedupe map.
 * Module state survives between runs in the same JVM, so a field left unreset
 * would carry one run's numbers - and one run's touched-order set - into the
 * next.
 */
function resetRun() {
    scannedA = 0;
    detectedA = 0;
    scannedB = 0;
    deliveredCount = 0;
    duplicateCount = 0;
    pendingCount = 0;
    manualReviewCount = 0;
    failedCount = 0;
    skippedCount = 0;
    configHalted = false;
    configMessage = '';
    sweepError = null;
    touchedInPassA = {};
}

/**
 * Folds one refundDelivery.deliverEntry() outcome into the run's aggregate
 * counters. Shared by both passes so the two summaries cannot drift apart.
 * @param {{disposition: string, state: string}} outcome
 */
function tallyOutcome(outcome) {
    if (outcome.disposition === 'CONFIG') {
        configHalted = true;
        configMessage = 'Gameball rejected the request as a configuration fault (code=' + (outcome.code || 'unknown')
            + ') - check the gameball.http.api.cred Service Credential.';
        return;
    }

    if (outcome.state === 'SENT') {
        deliveredCount++;
    } else if (outcome.state === 'DUPLICATE') {
        duplicateCount++;
    } else if (outcome.state === 'PENDING' || outcome.state === 'WAITING_FOR_ORDER') {
        pendingCount++;
    } else if (outcome.state === 'MANUAL_REVIEW') {
        manualReviewCount++;
    } else if (outcome.state === 'FAILED') {
        failedCount++;
    } else {
        skippedCount++;
    }
}

/**
 * Finds an existing, non-terminal DETECTOR/CANCELLATION entry on this
 * order's ledger, so a run that already recorded (but could not deliver) a
 * cancellation reuses it rather than allocating a second one for the same
 * event (section 5.2 step 7).
 * @param {Object[]} ledger
 * @returns {Object|null}
 */
function findReusableDetectorEntry(ledger) {
    for (var i = 0; i < ledger.length; i++) {
        var entry = ledger[i];
        if (entry && entry.source === 'DETECTOR' && entry.kind === 'CANCELLATION' && !refundStateStore.isTerminalState(entry.state)) {
            return entry;
        }
    }

    return null;
}

/**
 * Pass A callback: an order that was TRACKED and has since moved to
 * CANCELLED or FAILED. Re-asserts every guard the query predicate already
 * expresses (P7 - SFCC search may return NULL-valued documents) plus the
 * refund-specific ones the query cannot express at all (a negative
 * gbRefundState predicate would risk excluding exactly the never-refunded
 * orders this job exists to find - section 5.2's own note on why that
 * predicate is deliberately NOT in the query).
 *
 * The whole body is wrapped in its own try/catch (H19) so one bad order
 * cannot truncate a sweep that may touch thousands of rows.
 * @param {dw.order.Order} order
 */
function processOneCancellation(order) {
    try {
        scannedA++;

        if (configHalted || pacer.isHalted()) {
            return;
        }

        if (!order) {
            return;
        }

        if (!order.custom.gbTrackedAt || order.custom.gbTrackState !== 'TRACKED') {
            return;
        }

        var status = order.getStatus();
        if (status !== Order.ORDER_STATUS_CANCELLED && status !== Order.ORDER_STATUS_FAILED) {
            return;
        }

        var refundState = order.custom.gbRefundState;
        if (refundState === 'FULL' || refundState === 'MANUAL_REVIEW' || refundState === 'FAILED') {
            return;
        }

        if (refundState === 'PARTIAL') {
            // A partial refund already happened and now the order is
            // cancelled. Whether Gameball would double-reverse the
            // already-refunded portion on top of a blind full reversal is
            // undocumented (build-plan section 7.9 Q3) - escalate, never
            // guess. No ledger entry is created here (there is nothing to
            // deliver, only an order-level judgement call to record), so
            // this goes through refundStateStore's dedicated rollup-state
            // helper rather than allocateEntry.
            refundStateStore.setRollupState(order, 'MANUAL_REVIEW', 'cancelled_after_partial_refund');
            manualReviewCount++;
            return;
        }

        if (!order.custom.gbGameballOrderId || !order.custom.gbCustomerId) {
            // Nothing to reverse against / nothing to reverse for.
            return;
        }

        detectedA++;
        touchedInPassA[order.getOrderNo()] = true;

        var ledger = refundStateStore.readLedger(order);
        var entry = ledger === null ? null : findReusableDetectorEntry(ledger);

        if (!entry) {
            // Also reached when readLedger() returned null above -
            // allocateEntry re-reads and re-parses the ledger itself inside
            // its own transaction and is the sole writer that settles an
            // unparseable ledger to MANUAL_REVIEW (refundStateStore.js's own
            // ownership rule - this file never writes gbRefund* directly).
            var allocation = refundStateStore.allocateEntry(order, {
                kind: 'CANCELLATION',
                full: true,
                source: 'DETECTOR',
                state: 'PENDING'
            });

            if (allocation.error) {
                if (allocation.error !== 'CONCURRENT_MODIFICATION') {
                    manualReviewCount++;
                } else {
                    // Another process holds the order right now - left for
                    // this same order's next candidacy (it stays
                    // TRACKED/CANCELLED and matches again on a later run).
                    Logger.warn('{0}: order {1} skipped this run - concurrent modification while allocating a refund entry', STEP_NAME, order.getOrderNo());
                }
                return;
            }

            entry = allocation.entry;
        }

        if (!pacer.tryAcquire()) {
            // Budget spent - this order's entry is already recorded and
            // stays PENDING; the next run's Pass A (via
            // findReusableDetectorEntry) or Pass B (via gbRefundPendingAt)
            // picks it up.
            pendingCount++;
            return;
        }

        // Deliver in-process immediately rather than relying on Pass B to
        // pick it up in the same run: the order search index is
        // asynchronous, so Pass B's gbRefundPendingAt query would not see a
        // value written moments earlier in Pass A. Delivering while the
        // dw.order.Order object is already in hand sidesteps the index
        // entirely (section 5.2 step 8).
        var outcome = refundDelivery.deliverEntry(order, entry);
        tallyOutcome(outcome);

        if (outcome.disposition === 'CONFIG') {
            pacer.halt('CONFIG');
        }
    } catch (e) {
        Logger.error('{0} (Pass A) failed on order {1}: {2}', STEP_NAME,
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
    }
}

/**
 * Pass B callback: an order carrying at least one refund entry recorded but
 * not yet settled (gbRefundPendingAt). Retries work left behind by an
 * earlier run, or by gameballRefundApi.submitRefund's deferSend path.
 * @param {dw.order.Order} order
 */
function processOnePending(order) {
    try {
        scannedB++;

        if (configHalted || pacer.isHalted()) {
            return;
        }

        if (!order) {
            return;
        }

        // Re-assert predicate (P7): search may return NULL-valued documents.
        if (!order.custom.gbRefundPendingAt) {
            return;
        }

        // Orders touched in Pass A already had every deliverable entry
        // attempted this run - never attempted twice in one run (section
        // 5.2 step 13).
        if (touchedInPassA[order.getOrderNo()]) {
            return;
        }

        var summary = refundDelivery.deliverPending(order, orphanMaxHours);
        deliveredCount += summary.delivered;
        pendingCount += summary.pending;
        failedCount += summary.failed;
        skippedCount += summary.skipped;

        if (summary.config) {
            configHalted = true;
            configMessage = 'Gameball rejected a refund delivery as a configuration fault - check the gameball.http.api.cred Service Credential.';
        }
    } catch (e) {
        Logger.error('{0} (Pass B) failed on order {1}: {2}', STEP_NAME,
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
    }
}

/**
 * @returns {string} the one-line run summary. There is no Business Manager
 *          dashboard in this iteration (Skip: BM admin dashboard), so this
 *          line plus the step's exit status and the order-level gbRefund*
 *          fields ARE the operator surface.
 */
function buildSummary() {
    return 'scannedA=' + scannedA
        + ' detectedA=' + detectedA
        + ' scannedB=' + scannedB
        + ' delivered=' + deliveredCount
        + ' duplicate=' + duplicateCount
        + ' pending=' + pendingCount
        + ' manualReview=' + manualReviewCount
        + ' failed=' + failedCount
        + ' skipped=' + skippedCount
        + ' calls=' + pacer.getIssued()
        + ' haltReason=' + (pacer.getHaltReason() || 'none')
        + ' ms=' + pacer.getElapsedMs();
}

/**
 * custom.Gameball.RefundDetect - Pass A sends a full points reversal for any
 * order that was successfully tracked to Gameball and has since moved to
 * CANCELLED or FAILED; Pass B retries any refund left undelivered by an
 * earlier run or by gameballRefundApi.submitRefund's deferSend path.
 *
 * The honest coverage number (build-plan section 7.3, repeated verbatim in
 * docs/refunds-integration-guide.md and in gameballEnableRefunds' own
 * description): this automatic path catches roughly 10-20% of refund events
 * by count and less by value. Everything else is submitRefund().
 *
 * Never throws: a per-order failure is logged and the sweep continues (H19).
 * The step returns ERROR only for a merchant-actionable configuration
 * failure, an entry that settled FAILED this run, or a failure of the order
 * search itself - a handful of transiently-pending refunds is the normal,
 * self-healing steady state and must not turn the job red every hour.
 *
 * Neither argument is read: the step declares zero parameters and takes
 * everything from site preferences (J5).
 *
 * @param {Object} parameters - job step parameters (none declared)
 * @param {dw.job.JobStepExecution} stepExecution - job step execution
 * @returns {dw.system.Status}
 */
function execute(parameters, stepExecution) { // eslint-disable-line no-unused-vars
    var Status = require('dw/system/Status');
    Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.job');

    try {
        var System = require('dw/system/System');
        var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

        OrderMgr = require('dw/order/OrderMgr');
        Order = require('dw/order/Order');
        refundStateStore = require('*/cartridge/scripts/refund/refundStateStore');
        refundDelivery = require('*/cartridge/scripts/refund/refundDelivery');
        pacer = require('*/cartridge/scripts/job/gameballJobPacer');

        // Guard 1, first thing that runs (arbitration section 7 V-6, section
        // 5.4 guard 1). A sandbox data refresh copies production orders;
        // without this guard a refreshed sandbox would start re-POSTing
        // production REVERSALS to the configured Gameball workspace
        // unattended within one job interval. Status.OK rather than ERROR -
        // a non-Production instance correctly declining to run is expected
        // behaviour, not a failure anyone should be paged for.
        if (System.getInstanceType() !== System.PRODUCTION_SYSTEM
                && !readBooleanPreference('gameballAllowNonProductionSync', false)) {
            Logger.warn('{0} refused to run: this is not a Production instance and gameballAllowNonProductionSync is off', STEP_NAME);
            return new Status(Status.OK);
        }

        // Guard 2 (H37: feature flag AND credential configuration in one
        // named predicate, exactly as orderSyncGate.isGameballEnabled() and
        // refundGate.isGameballEnabled() both do it).
        if (!readBooleanPreference('gameballEnabled', false) || !gameballCredentials.isConfigured()) {
            Logger.info('{0} skipped: gameballEnabled={1}, gameball.http.api.cred configured={2}',
                STEP_NAME, readBooleanPreference('gameballEnabled', false), gameballCredentials.isConfigured());
            return new Status(Status.OK);
        }

        // Guard 3 - the refund feature's own master switch, independent of
        // order tracking staying on.
        if (!readBooleanPreference('gameballEnableRefunds', false)) {
            Logger.info('{0} skipped: gameballEnableRefunds is off', STEP_NAME);
            return new Status(Status.OK);
        }

        var config = readConfig();
        detectCancellations = config.detectCancellations;
        lookbackDays = config.lookbackDays;
        orphanMaxHours = config.orphanMaxHours;

        resetRun();
        pacer.start(MAX_SENDS_PER_RUN, config.maxRequestsPerSecond);

        lookbackStart = new Date(Date.now() - (lookbackDays * 86400000));

        Logger.info('{0} starting: detectCancellations={1} lookbackDays={2} orphanMaxHours={3}',
            STEP_NAME, detectCancellations, lookbackDays, orphanMaxHours);

        if (detectCancellations) {
            // A FULL lookback scan anchored on gbTrackedAt, re-run every
            // hour - NOT a moving window (section 5.2 step 4). gbTrackedAt
            // is written once and never mutates, so a windowed query would
            // be a ~1-hour-wide window on ORDER-PLACEMENT time: an order
            // tracked Monday and cancelled Friday would sit behind every
            // subsequent window and never be detected. The watermark this
            // job has none of is a deliberate omission, not a gap.
            try {
                OrderMgr.processOrders(
                    processOneCancellation,
                    'custom.gbTrackedAt >= {0} AND custom.gbTrackState = {1} AND (status = {2} OR status = {3})',
                    lookbackStart, 'TRACKED', Order.ORDER_STATUS_CANCELLED, Order.ORDER_STATUS_FAILED
                );
            } catch (searchErrorA) {
                sweepError = searchErrorA;
                Logger.error('{0}: Pass A order search failed: {1}', STEP_NAME, searchErrorA && searchErrorA.message);
            }
        } else {
            Logger.info('{0}: Pass A skipped, gameballRefundDetectCancellations is off', STEP_NAME);
        }

        if (!configHalted && !sweepError) {
            // Pass B: a positive range predicate, so an order with a NULL
            // gbRefundPendingAt (nothing pending) is correctly excluded by
            // the query itself rather than by a callback-side re-check
            // alone.
            try {
                OrderMgr.processOrders(processOnePending, 'custom.gbRefundPendingAt >= {0}', lookbackStart);
            } catch (searchErrorB) {
                sweepError = searchErrorB;
                Logger.error('{0}: Pass B order search failed: {1}', STEP_NAME, searchErrorB && searchErrorB.message);
            }
        }

        var summary = buildSummary();
        Logger.info('{0} finished: {1}', STEP_NAME, summary);

        if (configHalted) {
            return new Status(Status.ERROR, configMessage + ' [' + summary + ']');
        }

        if (sweepError) {
            return new Status(Status.ERROR, 'Gameball refund sweep failed: ' + (sweepError && sweepError.message) + ' [' + summary + ']');
        }

        if (failedCount > 0) {
            return new Status(Status.ERROR, failedCount + ' Gameball refund(s) failed; see the Gameball custom log [' + summary + ']');
        }

        // A halt from the per-run cap or the rate governor, and any number
        // of PENDING/MANUAL_REVIEW entries, is normal operation, not an
        // error - the next run (or an operator, for MANUAL_REVIEW) picks up
        // from here.
        return new Status(Status.OK);
    } catch (e) {
        Logger.error('{0} failed: {1}', STEP_NAME, e && e.message);
        return new Status(Status.ERROR, 'Gameball refund detection failed: ' + (e && e.message));
    }
}

module.exports = {
    execute: execute
};
