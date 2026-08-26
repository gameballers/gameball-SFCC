'use strict';

// The soft governor stays out of the way for this many calls at the start of a
// run. Both limbs below are SLIDING windows, so there is no first-call
// singularity left for a warm-up to paper over; what it now buys is a small,
// deliberately bounded head start, so a short run is not paced against a
// ceiling it was never going to approach. Twenty calls issued back to back is
// under Gameball's 30-per-second ceiling even if they land inside one second.
var GOVERNOR_WARMUP_CALLS = 20;

// The two limbs of Gameball's published ceiling (build plan section 13.7): 30
// requests per second AND 360 per rolling 30 seconds, both account-scoped. The
// second is the one that bites - it works out at 12 per second sustained, well
// below the first - and it is the reason the governor cannot simply be a
// per-second test. maxRps is taken from gameballMaxRequestsPerSecond and the
// 30-second allowance is derived from it rather than hard-coded to 360, so a
// merchant who divides the preference across sites divides BOTH limbs and
// stays inside one account-scoped budget.
var RATE_WINDOW_MS = 1000;
var BURST_WINDOW_MS = 30000;
var BURST_WINDOW_SECONDS = 30;

// Defensive clamps for the two preference-supplied inputs. A merchant can type
// anything into a Business Manager integer field, and 0 or a negative value
// would otherwise mean either "issue nothing, silently" or "divide the account
// budget by a nonsense number".
var MIN_MAX_CALLS = 1;
var MIN_MAX_RPS = 1;

// Per-run state (J7). Module scope, not closure scope, because a job step's
// callbacks are separate functions that all need to see the same counters -
// and start() resets every one of them, so state left behind by a previous run
// in the same JVM can never leak into the next.
//
// KNOWN LIMIT, deliberately not solved here: this is ONE run's state per JVM,
// with no run token. Two Gameball job steps running concurrently on the same
// application server would share these counters, and the second start() would
// reset the first run's budget and clear its halt flag.
// @supports-parallel-execution false does not prevent that - it only stops one
// job running twice. What prevents it today is the schedule: every Gameball job
// ships on a distinct start minute (05, 10, 20, 40) precisely so no two sweeps
// contend for one account-scoped budget. A run token was considered and
// rejected for now because it cannot work half-applied: the pacer's exported
// surface is fixed and the three later job items are already written against
// the tokenless form, so a token added here alone would default every one of
// them back to the shared slot and buy nothing. Whoever needs genuinely
// concurrent Gameball jobs must add the token here AND thread it through every
// caller in the same change.
var issued = 0;
var maxCallsAllowed = 0;
var maxRpsAllowed = 0;
var startedAtMs = 0;
var halted = false;
var haltReason = '';

// Issue timestamps inside the 30-second window, oldest first. Bounded by the
// 30-second allowance itself (300 entries at the default ceiling), because
// tryAcquire refuses once that many are in the window and prunes everything
// older on every call.
var issuedAtMs = [];

/**
 * Coerces a preference value to a positive integer, or falls back.
 * @param {*} value
 * @param {number} minimum
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, minimum, fallback) {
    var parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < minimum) {
        return fallback;
    }

    return parsed;
}

/**
 * Opens a pacing window for one job run. Call once, before the sweep.
 *
 * There is ONE pacer for the whole cartridge because there is ONE budget:
 * Gameball's 30-per-second / 360-per-rolling-30-seconds ceiling is
 * ACCOUNT-scoped, shared by every job, every site and the storefront. Each job
 * still owns its own per-run cap preference and passes it here; what it must
 * not own is its own idea of how fast the account may be driven.
 *
 * @param {number} maxCalls - per-run hard cap, from the calling job's own
 *        preference. Once spent, tryAcquire() refuses for the rest of the run.
 * @param {number} maxRps - soft governor ceiling, from
 *        gameballMaxRequestsPerSecond. A multi-site merchant DIVIDES this
 *        across the sites sharing one Gameball workspace; the limit is
 *        account-scoped, so it is divided, never multiplied.
 */
function start(maxCalls, maxRps) {
    issued = 0;
    maxCallsAllowed = toPositiveInt(maxCalls, MIN_MAX_CALLS, MIN_MAX_CALLS);
    maxRpsAllowed = toPositiveInt(maxRps, MIN_MAX_RPS, MIN_MAX_RPS);
    startedAtMs = Date.now();
    halted = false;
    haltReason = '';
    issuedAtMs = [];
}

/**
 * Drops issue timestamps that have aged out of the wider of the two windows.
 *
 * Called on every tryAcquire, so the array can never grow past the 30-second
 * allowance: entries leave by age here and entries stop arriving once that many
 * are inside the window.
 *
 * @param {number} nowMs
 */
function pruneIssuedAt(nowMs) {
    var cutoff = nowMs - BURST_WINDOW_MS;

    // Oldest first, so the expired entries are always a prefix.
    while (issuedAtMs.length && issuedAtMs[0] <= cutoff) {
        issuedAtMs.shift();
    }
}

/**
 * How many calls were issued strictly after cutoffMs.
 *
 * Counts backwards from the newest entry and stops as soon as the answer can
 * only be "at least the ceiling", so the walk is bounded by maxRps rather than
 * by the window length.
 *
 * @param {number} cutoffMs
 * @param {number} ceiling - stop counting here; the caller only needs to know
 *        whether the count reached it
 * @returns {number}
 */
function countIssuedSince(cutoffMs, ceiling) {
    var count = 0;

    for (var i = issuedAtMs.length - 1; i >= 0; i--) {
        if (issuedAtMs[i] <= cutoffMs) {
            break;
        }

        count++;
        if (count >= ceiling) {
            break;
        }
    }

    return count;
}

/**
 * Asks permission to issue one outbound call, and consumes the budget unit
 * when the answer is yes.
 *
 * The rate is measured over SLIDING windows - the last second and the last
 * thirty seconds - rather than as an average since start(). The average was the
 * original shape and it is wrong in a way that only shows up on the strategy
 * that needs it most: elapsed time accrues whether or not calls are issued, so
 * a sweep that spends five minutes walking out-of-window rows banks five
 * minutes' worth of allowance and may then fire its entire per-run budget as
 * one uninterrupted burst. PAGED_CUSTOMER_NO makes that the normal case, not a
 * corner one - it pages in customerNo order, so the profiles a bulk import
 * created sit contiguously and are reached as a block. The burst outruns the
 * 360-per-rolling-30-seconds limb, Gameball answers 429, the caller halts the
 * whole run, and the next run repeats the shape. A sliding window cannot bank
 * idle time, so it cannot produce that burst.
 *
 * Both tests are comparisons of counts. There is no division anywhere and no
 * elapsed=0 singularity to special-case.
 *
 * There is no sleep in SFCC (P12). The only throttle available to this
 * cartridge is to STOP ISSUING CALLS, which is exactly what a false return
 * means. Note the two falses are not the same: a governed refusal is temporary
 * and re-opens as wall-clock time passes (a sweep goes on reading rows, which
 * costs time, which retires the oldest entries from the window), while a capped
 * or halted refusal is final for the run. Callers that need to tell them apart
 * ask isHalted() and getIssued().
 *
 * @returns {boolean} true if a call may be issued now; false once capped,
 *          governed or halted
 */
function tryAcquire() {
    if (halted) {
        return false;
    }

    if (issued >= maxCallsAllowed) {
        return false;
    }

    var now = Date.now();
    pruneIssuedAt(now);

    if (issued >= GOVERNOR_WARMUP_CALLS) {
        // The 30-second limb first: it is the binding one at any sustained
        // rate, and refusing on it early saves walking the second-window count.
        var burstCeiling = maxRpsAllowed * BURST_WINDOW_SECONDS;
        if (issuedAtMs.length >= burstCeiling) {
            return false;
        }

        if (countIssuedSince(now - RATE_WINDOW_MS, maxRpsAllowed) >= maxRpsAllowed) {
            return false;
        }
    }

    issuedAtMs.push(now);
    issued++;
    return true;
}

/**
 * Closes the window for the rest of the run.
 *
 * This is how a caller converts a single decisive signal into a global stop -
 * one HTTP 429 means the account is over its ceiling right now, and continuing
 * to issue calls after seeing one is how a rate limit becomes a ban. It is also
 * how a CONFIG failure (bad key, disabled account) stops a sweep that would
 * otherwise mark twenty thousand records failed for one fixable reason.
 *
 * @param {string} reason - recorded verbatim and surfaced through
 *        getHaltReason(), so the job's run summary can say why it stopped
 */
function halt(reason) {
    halted = true;
    haltReason = reason ? String(reason) : 'halted';
}

/**
 * @returns {boolean} true once halt() has been called in this run
 */
function isHalted() {
    return halted;
}

/**
 * @returns {string} the reason passed to halt(), or '' when not halted
 */
function getHaltReason() {
    return haltReason;
}

/**
 * @returns {number} calls acquired so far in this run. A caller compares this
 *          against the cap it passed to start() to tell "capped" apart from
 *          "governed" without the pacer having to expose its own reason codes.
 */
function getIssued() {
    return issued;
}

/**
 * @returns {number} milliseconds since start(). Reported in run summaries and
 *          used by callers that enforce their own wall-clock budget against
 *          the step's declared timeout.
 */
function getElapsedMs() {
    return Date.now() - startedAtMs;
}

module.exports = {
    start: start,
    tryAcquire: tryAcquire,
    halt: halt,
    isHalted: isHalted,
    getHaltReason: getHaltReason,
    getIssued: getIssued,
    getElapsedMs: getElapsedMs
};
