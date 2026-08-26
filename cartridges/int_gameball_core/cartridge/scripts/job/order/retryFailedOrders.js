'use strict';

// NOTE the absence of module-level requires, matching deltaCustomers.js and
// erasureDrain.js. A job step module resolves nothing at load time (J8, the
// deliberate inverse of H2): the step type is registered at cartridge-load
// time, and a cartridge module that throws while being resolved takes down
// step registration rather than one job run. Everything is required inside
// execute() and held in the module-scope handles below.

// Base of the exponential spacing between attempts on one order (attempt N
// is not retried before base * 2^(N-1) minutes after the previous attempt),
// capped here so a very high attempt ceiling combined with a large backoff
// preference can never compute an absurd or non-finite wait. 480 minutes = 8
// hours: long enough that a two-hour Gameball outage cannot burn an order's
// whole attempt budget in two job runs (build-plan section 5.7), short
// enough that a fixable problem is retried well within one business day.
// gameballOrderApi.js's firstRetryAt() duplicates this same figure for the
// confirmation-page path's attempt-1 backoff - see the comment there for why
// that duplication (not a shared module) is the deliberate choice.
var MAX_BACKOFF_MINUTES = 480;

// Terminal orderSyncGate reasons this job settles the order on WITHOUT ever
// spending a Gameball call (arbitration section 4.4's ruling: this must be
// the complete eight-reason set the gate can return after item 05, not just
// the four that existed on `main` before guest orders shipped). 'gameball_
// disabled' is deliberately excluded - it is not terminal, it halts the run
// instead (see the block comment in processOne).
var TERMINAL_SKIP_REASONS = {
    no_order: true,
    terminal_status: true,
    profile_without_customer_no: true,
    guest_order: true,
    guest_order_mode_skip: true,
    guest_no_identifier: true,
    guest_id_too_long: true
};

// orderSyncGate.js reports a replacement order as
// 'replacement_order (' + originalOrderNo + ')', never the bare string, so
// this one reason is matched by prefix rather than through
// TERMINAL_SKIP_REASONS' exact-string lookup.
var REPLACEMENT_ORDER_PREFIX = 'replacement_order';

var TRACK_STATE_FAILED = 'FAILED';
var TRACK_STATE_TRACKED = 'TRACKED';
var TRACK_STATE_RETRY_EXHAUSTED = 'RETRY_EXHAUSTED';
var TRACK_STATE_FAILED_PERMANENT = 'FAILED_PERMANENT';

// Item 07's refund-anchor seed, mirrored from gameballOrderApi.js's own
// REFUND_STATE_NONE (same value, re-declared rather than imported - that
// constant is private to gameballOrderApi.js and a fifth export for one
// string literal is a worse trade than the duplicate, matching this file's
// existing resolveAttemptIdentity precedent). Written on every TRACKED
// settlement below for the same reason gameballOrderApi.js's sendOrder
// writes it: an order that reaches TRACKED without gbTrackedAt/
// gbTrackedTotalPaid/gbTrackedCurrency/gbRefundState is permanently invisible
// to the Gameball Refund Detector job, which anchors its whole query on
// gbTrackedAt. This job settles TRACKED independently of sendOrder (probe
// confirmation, a fresh resend, or an ALREADY_APPLIED confirmation) and must
// seed the same four keys every time it does, or every order this job
// recovers - which is the common case a transient failure exists to be
// recovered by, not a rare corner - would silently never be scanned for a
// later cancellation/refund.
var REFUND_STATE_NONE = 'NONE';

var STEP_NAME = 'retryFailedOrders~execute';

// Every gameballErrors call in this file is scoped to ORDER (arbitration
// section 4.9) so the 9000-9008 range and this job's synthetic transport
// tokens resolve through gameballErrors.js's ORDER override table.
var ORDER_SCOPE = { scope: 'ORDER' };

// Module handles, resolved once per run in execute() (J7/J8).
var Logger = null;
var OrderMgr = null;
var gameballOrderApi = null;
var gameballErrors = null;
var DISPOSITION = null;
var pacer = null;
var orderSyncGate = null;
var gameballIdentity = null;
var orderPayload = null;

// Per-run configuration, re-read by readConfig() at the top of every run
// (J7) - never assumed to be unchanged between runs in the same JVM.
var maxAttempts = 5;
var maxOrdersPerRun = 200;
var backoffMinutes = 30;
var probeBeforeResend = true;
var floorMs = 0;

// Per-run counters and halt state, every field reset by resetRun().
var scannedCount = 0;
var consideredCount = 0;
var deferredByBackoffCount = 0;
var skippedCount = 0;
var trackedCount = 0;
var alreadyAppliedCount = 0;
var probeSettledCount = 0;
var permanentCount = 0;
var exhaustedCount = 0;
var stillFailedCount = 0;
var configErrorMessage = '';
var sweepError = null;

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
 * Reads one integer site preference, clamped on both ends and defaulted.
 *
 * Clamped in code rather than with <min-value>/<max-value> in the metadata:
 * whether this XSD version accepts those elements is unverified, and a
 * metadata file that fails to import takes the merchant's entire site import
 * with it (arbitration section 2.8 rule 5).
 *
 * @param {string} id
 * @param {number} fallback - used when absent, unreadable, or out of range
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
 * @returns {{lookbackDays: number, maxAttempts: number, maxOrdersPerRun: number,
 *            backoffMinutes: number, maxRequestsPerSecond: number,
 *            probeBeforeResend: boolean}} clamped configuration
 */
function readConfig() {
    return {
        lookbackDays: readIntPreference('gameballRetryLookbackDays', 7, 1, 90),
        maxAttempts: readIntPreference('gameballRetryMaxAttempts', 5, 1, 20),
        maxOrdersPerRun: readIntPreference('gameballRetryMaxOrdersPerRun', 200, 1, 2000),
        backoffMinutes: readIntPreference('gameballRetryBackoffMinutes', 30, 0, 1440),
        // Not this item's preference (arbitration section 2.2, C-6: moved to
        // item 03 because the 360-per-30s ceiling is account-scoped and
        // shared by every job plus the storefront) - only read and clamped
        // here, never declared in this item's metadata section.
        maxRequestsPerSecond: readIntPreference('gameballMaxRequestsPerSecond', 10, 1, 12),
        probeBeforeResend: readBooleanPreference('gameballRetryProbeBeforeResend', true)
    };
}

/**
 * Exponential spacing between attempts on one order. No jitter: outbound
 * pacing is enforced by the per-run cap and the rate governor (gameballJobPacer),
 * not by spreading backoff, and a deterministic value is easier to explain to
 * an operator reading gbNextRetryAt in Business Manager.
 * @param {number} attemptsAfter - the attempt count AFTER this attempt
 * @param {number} baseMinutes
 * @returns {Date} earliest time this order may be attempted again
 */
function nextRetryAt(attemptsAfter, baseMinutes) {
    var exponent = attemptsAfter - 1;
    if (exponent < 0) {
        exponent = 0;
    }

    var minutes = baseMinutes * Math.pow(2, exponent);
    if (!isFinite(minutes) || minutes > MAX_BACKOFF_MINUTES) {
        minutes = MAX_BACKOFF_MINUTES;
    }

    return new Date(Date.now() + minutes * 60000);
}

/**
 * Prefers a previously-recorded identity over a fresh ladder derivation.
 * Duplicated (not imported) from gameballOrderApi.js's own private helper of
 * the same name: both files independently already require gameballIdentity,
 * the function is five lines, and arbitration section 4.3's frozen
 * module.exports for gameballOrderApi.js lists exactly four exports - adding
 * a fifth for one internal helper is a worse trade than one small duplicate.
 *
 * Binding handoff rule from spec 05 section 9.2 (cited as binding on this
 * item by arbitration section 1's 05-to-06 edge): once ANY attempt on this
 * order - success or failure - has recorded a value on
 * order.custom.gbCustomerId, that value is treated as sticky rather than
 * re-derived, because gameballIdentity.getOrderCustomerId is only
 * deterministic under FIXED inputs and gameballGuestOrderMode /
 * gameballLinkGuestOrdersByLogin / the shopper's own registration state can
 * all change between one attempt and the next. See gameballOrderApi.js's copy
 * of this function for the full reasoning and its ARCHITECTURAL LIMIT note
 * (orderPayload.build(), owned by item 05, always re-derives the identity it
 * actually POSTS - this function only controls what gets PERSISTED when
 * settling a state that is not a confirmed-fresh success).
 * @param {dw.order.Order} order
 * @returns {{customerId: string, source: string}}
 */
function resolveAttemptIdentity(order) {
    var storedId = order.custom.gbCustomerId;
    if (storedId) {
        return { customerId: storedId, source: order.custom.gbCustomerIdSource || '' };
    }

    return gameballIdentity.getOrderCustomerId(order);
}

/**
 * Best-effort totalPaid for seeding item 07's refund-anchor
 * (gbTrackedTotalPaid) when settling TRACKED via the probe-confirmation path,
 * where - unlike the fresh-SUCCESS and ALREADY_APPLIED branches below - there
 * is no outcome.body to read the actually-sent figure from: probeOrderTracked
 * only ever issues a GET, never a POST, so nothing was ever built or sent by
 * THIS attempt. The order that succeeded was an earlier, ambiguous attempt
 * whose own response never arrived, and its exact sent figure is gone.
 *
 * Recomputes via orderPayload.build() - the SAME formula attemptTrack() uses
 * to build the body it POSTs - rather than leaving the ceiling unset
 * indefinitely. This is not a departure from "never recomputed" (persistResult's
 * own comment, and gameballOrderApi.js's sendOrder/attemptTrack): that rule
 * guards against moving the ceiling out from under an ALREADY-tracked order
 * after it may have been edited; here the order is being tracked for the
 * first time in this call, so "recompute now" and "read the value the
 * original send used" agree unless the order changed in the narrow window
 * between the two attempts - the same imprecision this job's own
 * ALREADY_APPLIED branch already accepts (its outcome.body.totalPaid is also
 * a fresh build, not the original attempt's literal bytes; see that branch's
 * comment).
 *
 * A build() failure is caught and returns undefined so the caller leaves
 * gbTrackedTotalPaid untouched rather than throwing out of a TRACKED
 * settlement that must still complete: refundGate's own no_tracked_total
 * guard then routes any PARTIAL refund on this order to MANUAL_REVIEW rather
 * than guessing, exactly the documented fallback for an order with no known
 * total (spec section 8, "order tracked before this item shipped"). A FULL
 * reversal needs no ceiling and is unaffected.
 * @param {dw.order.Order} order
 * @returns {number|undefined}
 */
function recomputeTotalPaidForAnchor(order) {
    try {
        return orderPayload.build(order).totalPaid;
    } catch (e) {
        return undefined;
    }
}

/**
 * @param {string} reason - an orderSyncGate.evaluate() reason string
 * @returns {boolean} true when the order should be settled SKIPPED without
 *   spending a Gameball call, per the complete eight-reason terminal set
 */
function isTerminalSkipReason(reason) {
    if (!reason) {
        return false;
    }

    if (TERMINAL_SKIP_REASONS[reason] === true) {
        return true;
    }

    return reason.indexOf(REPLACEMENT_ORDER_PREFIX) === 0;
}

/**
 * Settles a retryable (non-terminal, non-CONFIG, non-SERVICE_UNAVAILABLE)
 * failure: burns one attempt, and either backs off for another try or - if
 * this was the last attempt the order was allowed - settles it straight to
 * RETRY_EXHAUSTED in the SAME transaction, rather than waiting for the next
 * run's attempt-cap re-assertion (one fewer index round-trip, and the
 * terminal state is visible to the operator immediately).
 * @param {dw.order.Order} order
 * @param {number} attemptsAfter - the attempt count AFTER this attempt
 * @param {string} code
 * @param {string} requestId
 * @param {string} message
 * @param {{customerId: string, source: string}} identity - resolveAttemptIdentity's
 *   result, persisted alongside the failure so a LATER attempt has a stored
 *   value to reuse instead of re-deriving (spec 05 section 9.2)
 */
function settleRetryableFailure(order, attemptsAfter, code, requestId, message, identity) {
    var exhaustedNow = attemptsAfter >= maxAttempts;

    gameballOrderApi.persistResult(order, {
        gbTrackState: exhaustedNow ? TRACK_STATE_RETRY_EXHAUSTED : TRACK_STATE_FAILED,
        gbCustomerId: identity.customerId,
        gbCustomerIdSource: identity.source,
        gbLastError: message,
        gbLastErrorCode: code,
        gbLastRequestId: requestId || '',
        gbLastAttemptAt: new Date(),
        gbRetryAttempts: attemptsAfter,
        gbNextRetryAt: exhaustedNow ? null : nextRetryAt(attemptsAfter, backoffMinutes)
    });

    if (exhaustedNow) {
        exhaustedCount++;
    } else {
        stillFailedCount++;
    }
}

/**
 * The dw.order.OrderMgr.processOrders callback. Re-asserts every query
 * predicate (rule P7), applies the attempt cap, the backoff gate, the
 * stored-code classification, the pacer, and the sync gate, then sends.
 * Never throws - the whole body is caught (H19) so one bad order cannot
 * truncate a sweep that may touch thousands of rows.
 * @param {dw.order.Order} order
 */
function processOne(order) {
    try {
        scannedCount++;

        // Once halted, every remaining row is a no-op. OrderMgr.processOrders
        // cannot be aborted from the callback and MUST NOT be aborted by
        // throwing - a throw here would propagate out of the sweep and
        // abandon every order behind it. The index scan still runs to
        // completion; only the HTTP work is gated.
        if (pacer.isHalted()) {
            return;
        }

        if (!order) {
            return;
        }

        // Re-assert predicate: state (P7 - search may return NULL-valued
        // docs). Also the race guard: if the shopper reloaded the
        // confirmation page between the query and this callback and the
        // order is now TRACKED, it is dropped here with zero HTTP.
        if (order.custom.gbTrackState !== TRACK_STATE_FAILED) {
            return;
        }

        // Re-assert predicate: lookback floor.
        var created = order.getCreationDate();
        if (!created || created.getTime() < floorMs) {
            return;
        }

        consideredCount++;

        var attempts = Number(order.custom.gbRetryAttempts) || 0;
        if (attempts >= maxAttempts) {
            // Settling here (rather than merely skipping) is what makes the
            // candidate set self-drain, and it also cleans up a backlog
            // after a merchant LOWERS gameballRetryMaxAttempts. Zero HTTP.
            gameballOrderApi.persistResult(order, { gbTrackState: TRACK_STATE_RETRY_EXHAUSTED, gbNextRetryAt: null });
            exhaustedCount++;
            return;
        }

        var nextAt = order.custom.gbNextRetryAt;
        if (nextAt && nextAt.getTime() > Date.now()) {
            deferredByBackoffCount++;
            return;
        }

        // Classify the STORED code before spending a call - a PERMANENT
        // stored code (a 3000-class "required arguments missing" that will
        // fail identically forever) is settled without ever being re-sent.
        // This is a safety net: sendOrder now settles these on the
        // confirmation page too, so in steady state this branch only catches
        // orders that failed before this item shipped.
        //
        // An empty/missing code is handled here, BEFORE the shared
        // classifier ever sees it, rather than by editing
        // gameballErrors.classifyStoredCode's own empty-key branch (shared,
        // item-03-owned code per arbitration section 4.9, and its current
        // default of TRANSIENT is deliberately scope-blind). For THIS scope
        // specifically the two documented cases that carry no code at all -
        // an order that failed before this item shipped, or one whose first
        // attempt threw before it could classify anything - must route
        // through the verification probe (AMBIGUOUS), never a blind re-POST
        // (TRANSIENT): "no code recorded" means "we genuinely do not know
        // what happened", which is the definition of ambiguous, not of
        // "Gameball said try again".
        var storedCode = order.custom.gbLastErrorCode;
        var storedDisposition = storedCode
            ? gameballErrors.classifyStoredCode(storedCode, ORDER_SCOPE)
            : DISPOSITION.AMBIGUOUS;
        if (storedDisposition === DISPOSITION.PERMANENT) {
            gameballOrderApi.persistResult(order, { gbTrackState: TRACK_STATE_FAILED_PERMANENT, gbNextRetryAt: null });
            permanentCount++;
            return;
        }
        // CONFIG, or anything else the stored code classifies as: fall
        // through. A credential fix is exactly what this job exists to
        // recover from, and every other stored disposition is retryable.

        // Per-run cap + rate governor. tryAcquire() sets the halt reason
        // internally (RUN_CAP or RATE) and returns false; the next callback
        // invocation short-circuits at the isHalted() check above.
        if (!pacer.tryAcquire()) {
            return;
        }

        var gate = orderSyncGate.evaluate(order);

        if (!gate.shouldTrack) {
            if (gate.reason === 'gameball_disabled') {
                // Unreachable given execute()'s guard 3 (above, before the
                // sweep starts) - kept as a second, independent check because
                // a merchant flipping gameballEnabled off mid-run must stop
                // the run WITHOUT writing anything, rather than have every
                // remaining row in this run's candidate set rewritten to
                // SKIPPED and permanently lost. See execute()'s guard-3
                // comment for the full reasoning.
                pacer.halt('DISABLED');
                return;
            }

            if (isTerminalSkipReason(gate.reason)) {
                // This is the "cancelled since it failed" requirement:
                // terminal_status fires for ORDER_STATUS_CANCELLED and
                // ORDER_STATUS_FAILED, so an order cancelled after it failed
                // is settled SKIPPED here and never tracked (build-plan
                // section 5.8: "suppression beats compensation").
                gameballOrderApi.persistResult(order, {
                    gbTrackState: gate.skipState,
                    gbLastError: 'Skipped on retry: ' + gate.reason,
                    gbNextRetryAt: null
                });
                skippedCount++;
                return;
            }

            // Fail safe, not fail silent: a gate reason this job does not
            // recognise - because a later item introduced one - leaves the
            // order FAILED for a human to look at, rather than guessing at
            // its terminal state on a reason nobody vetted (arbitration
            // section 4.4's ruling on the complete terminal-reason set).
            Logger.warn('{0}: order {1} left FAILED - unrecognised sync-gate reason "{2}"',
                STEP_NAME, order.getOrderNo(), gate.reason);
            return;
        }

        // Reuse a previously-recorded identity rather than re-deriving one
        // (resolveAttemptIdentity, above) - spec 05 section 9.2, binding on
        // this item per arbitration section 1's 05-to-06 edge. Falls back to
        // the ladder only for an order that has never had one persisted.
        var identity = resolveAttemptIdentity(order);

        if (probeBeforeResend && storedDisposition === DISPOSITION.AMBIGUOUS) {
            var probe = gameballOrderApi.probeOrderTracked(order.getOrderNo());

            if (probe === true) {
                // Gameball already holds a reward transaction for this
                // orderId - settle success WITHOUT a second POST. This is
                // the double-award guard build-plan section 5.5 mandates for
                // a previously-ambiguous outcome (a timeout, a connection
                // fault, or an HTTP 500 that may have landed anyway).
                gameballOrderApi.persistResult(order, {
                    gbTrackState: TRACK_STATE_TRACKED,
                    gbGameballOrderId: order.getOrderNo(),
                    gbCustomerId: identity.customerId,
                    gbCustomerIdSource: identity.source,
                    gbLastError: null,
                    gbLastErrorCode: null,
                    gbLastRequestId: null,
                    gbNextRetryAt: null,
                    gbLastAttemptAt: new Date(),
                    gbRetryAttempts: attempts + 1,
                    // Item 07's refund anchor and ceiling - this order is
                    // reaching TRACKED for the first time right here (an
                    // earlier ambiguous attempt's response never arrived, and
                    // the probe just confirmed Gameball holds it anyway), so
                    // gbTrackedAt/gbTrackedTotalPaid/gbTrackedCurrency/
                    // gbRefundState must be seeded now or this order is
                    // permanently invisible to the Refund Detector job (see
                    // this file's REFUND_STATE_NONE comment). totalPaid has
                    // no outcome.body to read here - see
                    // recomputeTotalPaidForAnchor's own JSDoc for why.
                    gbTrackedAt: new Date(),
                    gbTrackedTotalPaid: recomputeTotalPaidForAnchor(order),
                    gbTrackedCurrency: order.getCurrencyCode(),
                    gbRefundState: REFUND_STATE_NONE
                });
                probeSettledCount++;
                return;
            }

            if (probe === null) {
                // The probe itself failed. Deliberately conservative: an
                // unverifiable ambiguous order is never blind-resent. The
                // attempt counter still advances, so this cannot loop
                // forever - it terminates at RETRY_EXHAUSTED with an
                // explicit, greppable code.
                settleRetryableFailure(order, attempts + 1, 'PROBE_FAILED', '',
                    'Gameball order-tracked verification probe failed before this order could be safely re-sent',
                    identity);
                return;
            }

            // probe === false: Gameball has no reward transaction for this
            // order yet - fall through to a real send. This needs a SECOND
            // budget unit, because the tryAcquire() above only reserved the
            // one the probe itself just spent.
            if (!pacer.tryAcquire()) {
                return;
            }
        }

        var outcome = gameballOrderApi.attemptTrack(order);

        if (outcome.disposition === DISPOSITION.SUCCESS) {
            // A fresh 2xx: Gameball just recorded this order for the first
            // time under exactly what THIS call sent, so the payload's own
            // echoed customerId is the new ground truth and supersedes
            // anything stored from an earlier attempt - provably the value
            // actually sent (spec 05 section 9.1 - item 07's refund handoff
            // depends on this).
            gameballOrderApi.persistResult(order, {
                gbTrackState: TRACK_STATE_TRACKED,
                gbGameballOrderId: outcome.body && outcome.body.orderId,
                gbCustomerId: outcome.body && outcome.body.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: null,
                gbLastErrorCode: null,
                gbLastRequestId: null,
                gbNextRetryAt: null,
                gbLastAttemptAt: new Date(),
                gbRetryAttempts: attempts + 1,
                // Item 07's refund anchor and ceiling, seeded here for the
                // same reason gameballOrderApi.js's sendOrder seeds it on its
                // own SUCCESS branch - this job's own TRACKED settlement was
                // missing it entirely (see REFUND_STATE_NONE's comment
                // above). totalPaid read off outcome.body - the exact figure
                // THIS call sent, never recomputed - and currency off the
                // order itself, exactly mirroring sendOrder's own SUCCESS
                // branch.
                gbTrackedAt: new Date(),
                gbTrackedTotalPaid: outcome.body && outcome.body.totalPaid,
                gbTrackedCurrency: order.getCurrencyCode(),
                gbRefundState: REFUND_STATE_NONE
            });
            trackedCount++;
            return;
        }

        if (outcome.disposition === DISPOSITION.ALREADY_APPLIED) {
            // Gameball is confirming a transaction an EARLIER attempt
            // already created (9000-9008, ORDER scope) - the identity that
            // attempt actually used is the ground truth here, not whatever
            // THIS re-send's independently re-derived payload happened to
            // carry (identity.customerId, not outcome.body.customerId - see
            // resolveAttemptIdentity's ARCHITECTURAL LIMIT note for why the
            // payload itself can still drift even though what gets persisted
            // here does not; spec 05 section 9.1 on why this matters to item
            // 07's refund handoff).
            gameballOrderApi.persistResult(order, {
                gbTrackState: TRACK_STATE_TRACKED,
                gbGameballOrderId: outcome.body && outcome.body.orderId,
                gbCustomerId: identity.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: null,
                gbLastErrorCode: null,
                gbLastRequestId: null,
                gbNextRetryAt: null,
                gbLastAttemptAt: new Date(),
                gbRetryAttempts: attempts + 1,
                // Also seeded on the ALREADY_APPLIED path (see the SUCCESS
                // branch above and REFUND_STATE_NONE's comment): this order
                // is reaching TRACKED for the first time here too whenever an
                // earlier attempt's own response never arrived. outcome.body
                // is the exact payload THIS call sent, so totalPaid is still
                // the true current figure even though the disposition is a
                // confirmation rather than a fresh 2xx (mirrors
                // gameballOrderApi.js's sendOrder ALREADY_APPLIED branch).
                gbTrackedAt: new Date(),
                gbTrackedTotalPaid: outcome.body && outcome.body.totalPaid,
                gbTrackedCurrency: order.getCurrencyCode(),
                gbRefundState: REFUND_STATE_NONE
            });
            alreadyAppliedCount++;
            return;
        }

        if (outcome.disposition === DISPOSITION.PERMANENT) {
            // Settled and logged unconditionally, not just for the
            // alert-worthy subset (3008/7000/9005): gameballErrors.classify
            // already appends each row's remediation text into
            // outcome.message where one exists, so a single ERROR line here
            // carries the actionable detail whenever there is any, without
            // this file needing its own duplicate list of "interesting"
            // codes that could drift from gameballErrors.js's table.
            Logger.error('{0}: order {1} permanently failed (code={2} requestId={3}): {4}',
                STEP_NAME, order.getOrderNo(), outcome.code, outcome.requestId, outcome.message);
            gameballOrderApi.persistResult(order, {
                gbTrackState: TRACK_STATE_FAILED_PERMANENT,
                gbCustomerId: identity.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: outcome.message,
                gbLastErrorCode: outcome.code,
                gbLastRequestId: outcome.requestId,
                gbLastAttemptAt: new Date(),
                gbRetryAttempts: attempts + 1,
                gbNextRetryAt: null
            });
            permanentCount++;
            return;
        }

        if (outcome.disposition === DISPOSITION.CONFIG) {
            // Halt after the FIRST CONFIG response and do NOT burn the
            // attempt budget (S26 - a bad credential is not this order's
            // fault). Grinding a bad key through the rest of a multi-
            // thousand-row backlog is how a cartridge gets its Gameball
            // account blacklisted (build-plan section 4.4). The step exits
            // ERROR so Business Manager job history goes red until a human
            // fixes it - there is no cross-run circuit breaker here (that
            // would need a GameballJobState-style watermark, which is Skip:
            // queue infrastructure).
            gameballOrderApi.persistResult(order, {
                gbCustomerId: identity.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: outcome.message,
                gbLastErrorCode: outcome.code,
                gbLastRequestId: outcome.requestId,
                gbLastAttemptAt: new Date()
            });
            configErrorMessage = 'Gameball rejected the request as a configuration fault (code='
                + (outcome.code || 'unknown') + '): ' + outcome.message
                + ' - check the gameball.http.api.cred Service Credential.';
            pacer.halt('CONFIG');
            return;
        }

        if (outcome.disposition === DISPOSITION.SERVICE_UNAVAILABLE) {
            // SFCC's own rate limiter or an open circuit breaker - the call
            // never reached Gameball, so the attempt budget is NOT burned
            // (S26). Halts the run rather than continuing to hammer a valve
            // the platform itself closed; the order stays FAILED and the
            // next run tries again.
            gameballOrderApi.persistResult(order, {
                gbCustomerId: identity.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: outcome.message,
                gbLastErrorCode: outcome.code,
                gbLastRequestId: outcome.requestId,
                gbLastAttemptAt: new Date()
            });
            pacer.halt('SERVICE_UNAVAILABLE');
            stillFailedCount++;
            return;
        }

        // TRANSIENT, AMBIGUOUS, or anything a future Gameball code falls
        // through to (gameballErrors' own fail-safe default). All three burn
        // the attempt budget and back off.
        settleRetryableFailure(order, attempts + 1, outcome.code, outcome.requestId, outcome.message, identity);

        if (outcome.httpStatus === 429) {
            // One 429 means the ACCOUNT is over its ceiling right now -
            // continuing to issue calls after seeing one is how a rate limit
            // becomes a ban. No Retry-After is documented by Gameball
            // (build-plan section 13.7), so the fixed backoff already
            // applied above stands.
            pacer.halt('RATE');
        }
    } catch (e) {
        stillFailedCount++;
        Logger.error('{0} failed on order {1}: {2}', STEP_NAME,
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
    }
}

/**
 * Resets every per-run counter and halt-adjacent field. Module state
 * survives between runs in the same JVM, so a field left unreset would carry
 * one run's numbers into the next.
 */
function resetRun() {
    scannedCount = 0;
    consideredCount = 0;
    deferredByBackoffCount = 0;
    skippedCount = 0;
    trackedCount = 0;
    alreadyAppliedCount = 0;
    probeSettledCount = 0;
    permanentCount = 0;
    exhaustedCount = 0;
    stillFailedCount = 0;
    configErrorMessage = '';
    sweepError = null;
}

/**
 * @returns {string} the one-line run summary. There is no Business Manager
 *          dashboard in this iteration (Skip: BM admin dashboard), so this
 *          line plus the step's exit status and the order-level gb* fields
 *          ARE the operator surface.
 */
function buildSummary() {
    return 'scanned=' + scannedCount
        + ' considered=' + consideredCount
        + ' deferredByBackoff=' + deferredByBackoffCount
        + ' skipped=' + skippedCount
        + ' tracked=' + trackedCount
        + ' alreadyApplied=' + alreadyAppliedCount
        + ' probeSettled=' + probeSettledCount
        + ' permanent=' + permanentCount
        + ' exhausted=' + exhaustedCount
        + ' stillFailed=' + stillFailedCount
        + ' calls=' + pacer.getIssued()
        + ' haltReason=' + (pacer.getHaltReason() || 'none')
        + ' ms=' + pacer.getElapsedMs();
}

/**
 * custom.Gameball.OrderRetry - re-attempts Gameball order tracking for every
 * order left in gbTrackState FAILED within the configured lookback, bounded
 * by a per-order attempt cap and a per-run call cap.
 *
 * Anchored on the MUTABLE gbTrackState field, never on a moving window over
 * an immutable timestamp - see build-plan section 5.6 for the defect that
 * shape causes and section 5.1 of this item's spec for why this job's query
 * cannot repeat it. Compare Yotpo's shipped order export
 * (creationDate >= {0} AND creationDate <= {1} AND ...), which is precisely
 * the double-bounded moving window this job deliberately does not copy.
 *
 * Never throws: a per-order failure is logged and the sweep continues (H19).
 * The step returns ERROR only for a merchant-actionable configuration
 * failure (bad credentials, Gameball disabled account-side) or a failure of
 * the order search itself - a handful of retryable rows is the normal,
 * self-healing steady state and must not turn the job red every hour.
 *
 * Neither argument is read: the step declares zero parameters and takes
 * everything from site preferences (J5). They are in the signature because
 * the platform's task-step contract supplies them.
 *
 * @param {Object} parameters - job step parameters (none declared)
 * @param {dw.job.JobStepExecution} stepExecution - job step execution
 * @returns {dw.system.Status} Status.OK, or Status.ERROR with a message
 */
function execute(parameters, stepExecution) { // eslint-disable-line no-unused-vars
    var Status = require('dw/system/Status');
    Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.job');

    try {
        var System = require('dw/system/System');
        var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

        OrderMgr = require('dw/order/OrderMgr');
        gameballOrderApi = require('*/cartridge/scripts/api/gameballOrderApi');
        gameballErrors = require('*/cartridge/scripts/util/gameballErrors');
        DISPOSITION = gameballErrors.DISPOSITION;
        pacer = require('*/cartridge/scripts/job/gameballJobPacer');
        orderSyncGate = require('*/cartridge/scripts/order/orderSyncGate');
        gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');
        // Pure payload builder only (no HTTP) - required here solely so the
        // probe-settled branch below can recompute totalPaid for the refund
        // anchor without a second POST. See recomputeTotalPaidForAnchor's own
        // JSDoc for why that branch has no outcome.body to read it from.
        orderPayload = require('*/cartridge/models/payload/orderPayload');

        // Guard 1, first thing that runs. A sandbox data refresh copies
        // production orders; without this guard a refreshed sandbox would
        // start re-POSTing production orders to the configured Gameball
        // workspace unattended within one job interval (arbitration section
        // 7 V-6 - this guard was missing from the original spec and is a
        // required addition, not optional). Status.OK rather than ERROR
        // because a non-Production instance correctly declining to run is
        // expected behaviour, not a failure anyone should be paged for.
        if (System.getInstanceType() !== System.PRODUCTION_SYSTEM
                && !readBooleanPreference('gameballAllowNonProductionSync', false)) {
            Logger.warn('{0} refused to run: this is not a Production instance and gameballAllowNonProductionSync is off',
                STEP_NAME);
            return new Status(Status.OK);
        }

        // Guard 2 - master switch for this job step, independent of
        // gameballEnabled so the retry sweep can be paused without turning
        // off live order tracking.
        if (!readBooleanPreference('gameballRetryEnabled', true)) {
            Logger.info('{0} skipped: gameballRetryEnabled is off', STEP_NAME);
            return new Status(Status.OK);
        }

        // Guard 3 - integration switch (H37: feature flag AND credential
        // configuration in one predicate). LOAD-BEARING, and must run BEFORE
        // the sweep, not inside the callback: if the merchant toggles
        // gameballEnabled off for an hour, orderSyncGate.evaluate() would
        // return {shouldTrack:false, skipState:'SKIPPED',
        // reason:'gameball_disabled'} for EVERY order, and a callback that
        // naively settled on gate.skipState would rewrite the entire FAILED
        // backlog to SKIPPED and destroy it permanently. The in-callback
        // 'gameball_disabled' branch in processOne only guards the run
        // being toggled off WHILE it is already in progress.
        if (!readBooleanPreference('gameballEnabled', false) || !gameballCredentials.isConfigured()) {
            Logger.info('{0} skipped: gameballEnabled={1}, gameball.http.api.cred configured={2}',
                STEP_NAME, readBooleanPreference('gameballEnabled', false), gameballCredentials.isConfigured());
            return new Status(Status.OK);
        }

        var config = readConfig();
        maxAttempts = config.maxAttempts;
        maxOrdersPerRun = config.maxOrdersPerRun;
        backoffMinutes = config.backoffMinutes;
        probeBeforeResend = config.probeBeforeResend;

        resetRun();
        pacer.start(maxOrdersPerRun, config.maxRequestsPerSecond);

        var floorDate = new Date(Date.now() - (config.lookbackDays * 86400000));
        floorMs = floorDate.getTime();

        Logger.info('{0} starting: lookbackDays={1} maxAttempts={2} maxOrdersPerRun={3} backoffMinutes={4} probeBeforeResend={5}',
            STEP_NAME, config.lookbackDays, maxAttempts, maxOrdersPerRun, backoffMinutes, probeBeforeResend);

        // custom.gbTrackState = 'FAILED' is the PRIMARY predicate - a mutable
        // field this job itself is the writer of. An order enters the
        // candidate set the moment it fails and leaves it only when
        // something settles it to a terminal state; there is no instant at
        // which a still-failed order is not matched. creationDate >= floor
        // is a LOWER BOUND ONLY, recomputed from now on every run, so it can
        // only ever retire very old orders - it can never step over a row.
        // There is no watermark and no persisted cursor (build-plan section
        // 5.6: "the watermark is an optimisation for logging only, never a
        // filter" - this job does not have one at all).
        try {
            OrderMgr.processOrders(processOne, 'custom.gbTrackState = {0} AND creationDate >= {1}', TRACK_STATE_FAILED, floorDate);
        } catch (searchError) {
            sweepError = searchError;
            Logger.error('{0}: order search failed: {1}', STEP_NAME, searchError && searchError.message);
        }

        var summary = buildSummary();
        Logger.info('{0} finished: {1}', STEP_NAME, summary);

        if (configErrorMessage) {
            return new Status(Status.ERROR, configErrorMessage + ' [' + summary + ']');
        }

        if (sweepError) {
            return new Status(Status.ERROR, 'Gameball retry sweep failed: ' + (sweepError && sweepError.message) + ' [' + summary + ']');
        }

        // A halt from the per-run cap or the rate governor is normal
        // operation, not an error - the remaining orders are still FAILED
        // and the next run picks them up.
        return new Status(Status.OK);
    } catch (e) {
        Logger.error('{0} failed: {1}', STEP_NAME, e && e.message);
        return new Status(Status.ERROR, 'Gameball order retry failed: ' + (e && e.message));
    }
}

module.exports = {
    execute: execute
};
