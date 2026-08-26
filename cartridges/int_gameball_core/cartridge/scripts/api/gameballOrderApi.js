'use strict';

var Site = require('dw/system/Site');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var orderPayload = require('*/cartridge/models/payload/orderPayload');
var orderSyncGate = require('*/cartridge/scripts/order/orderSyncGate');
var gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');
var gameballErrors = require('*/cartridge/scripts/util/gameballErrors');

var TRACK_STATE_TRACKED = 'TRACKED';
var TRACK_STATE_FAILED = 'FAILED';
var TRACK_STATE_FAILED_PERMANENT = 'FAILED_PERMANENT';
var TRACK_STATE_RETRY_EXHAUSTED = 'RETRY_EXHAUSTED';

var DISPOSITION = gameballErrors.DISPOSITION;

// Every classify()/classifyStoredCode() call in this file is scoped to ORDER
// (arbitration section 4.9) so the 9000-9008 range and this file's own
// synthetic transport tokens resolve through gameballErrors.js's ORDER
// override table rather than the shared default table.
var ORDER_SCOPE = { scope: 'ORDER' };

// gbLastError is a plain `string` custom attribute, whose SFCC ceiling is
// 4000 characters. The current code writes result.errorMessage unbounded -
// an HTML error page from an intermediate proxy would blow past that ceiling
// and throw INSIDE the failure-persistence path itself (H20: that path must
// never throw). 1000 leaves generous headroom under the platform ceiling
// while keeping the attribute readable in the Business Manager order screen.
var MAX_ERROR_LENGTH = 1000;

// The confirmation-page path's one-time backoff on a failed attempt is
// deliberately NOT the full exponential ladder retryFailedOrders.js computes
// for later attempts (build-plan section 5.7 / spec 06 section 6.1's
// nextRetryAt) - at attempt 1 the two formulas agree anyway
// (base * 2^0 == base), so duplicating just the base-and-cap shape here
// costs three lines rather than importing a job-step module into the API
// layer (job modules are the leaf of the dependency graph in this cartridge,
// never a dependency of it) or growing a shared gameballConstants module,
// which arbitration section 7 V-10 explicitly keeps out of this train. Kept
// identical to retryFailedOrders.js's own MAX_BACKOFF_MINUTES so neither path
// can quietly drift from the other's ceiling.
var RETRY_BACKOFF_MAX_MINUTES = 480;
var DEFAULT_RETRY_BACKOFF_MINUTES = 30;

/**
 * @returns {boolean} true when the guest-order no-email/no-mobile warning
 * below should be written (H28: warn/info gate on gameballInfoLogEnabled).
 * That preference is owned by item 02 and already exists on this cartridge's
 * `main` - not re-declared here (a duplicate attribute-id fails the whole
 * metadata import). Mirrors gameballCustomerApi.js's readBooleanPreference()
 * rather than importing it: that helper isn't exported, and requiring the
 * whole customer API module here just for a log gate would be a stranger
 * dependency than one more four-line preference read. Defaults to true (the
 * documented "info logging defaults to on" behaviour) so a not-yet-imported
 * or unreadable preference never silently swallows the one line that would
 * tell an operator a guest profile can never be reconciled.
 * @returns {boolean}
 */
function isInfoLogEnabled() {
    try {
        var site = Site.getCurrent();
        if (!site) {
            return true;
        }

        var value = site.getCustomPreferenceValue('gameballInfoLogEnabled');
        if (value === null || value === undefined) {
            return true;
        }

        return !!value;
    } catch (e) {
        return true;
    }
}

/**
 * Reads gameballRetryBackoffMinutes, clamped and defaulted. Read here (not
 * only by retryFailedOrders.js) because the confirmation-page path needs the
 * SAME base figure for its own one-time backoff - see firstRetryAt().
 * @returns {number}
 */
function readRetryBackoffMinutes() {
    try {
        var site = Site.getCurrent();
        if (!site) {
            return DEFAULT_RETRY_BACKOFF_MINUTES;
        }

        var parsed = parseInt(site.getCustomPreferenceValue('gameballRetryBackoffMinutes'), 10);
        if (isNaN(parsed) || parsed < 0) {
            return DEFAULT_RETRY_BACKOFF_MINUTES;
        }

        return parsed > RETRY_BACKOFF_MAX_MINUTES ? RETRY_BACKOFF_MAX_MINUTES : parsed;
    } catch (e) {
        return DEFAULT_RETRY_BACKOFF_MINUTES;
    }
}

/**
 * The confirmation-page path's earliest-retry timestamp on a failed attempt.
 * Not exponential - this IS attempt 1, so the base figure and the exponential
 * ladder retryFailedOrders.js applies from attempt 2 onward agree exactly.
 * @returns {Date}
 */
function firstRetryAt() {
    return new Date(Date.now() + readRetryBackoffMinutes() * 60000);
}

/**
 * Truncates a value to MAX_ERROR_LENGTH characters so a persisted gbLastError
 * can never itself blow past the attribute's own length ceiling. Returns ''
 * for a null/undefined input rather than the strings 'null'/'undefined'.
 * @param {*} value
 * @returns {string}
 */
function truncateError(value) {
    var str = value === null || value === undefined ? '' : String(value);
    return str.length > MAX_ERROR_LENGTH ? str.substring(0, MAX_ERROR_LENGTH) : str;
}

/**
 * Prefers a previously-recorded identity over a fresh ladder derivation.
 *
 * Binding handoff rule from spec 05 section 9.2 (cited as binding on this
 * item by arbitration section 1's 05-to-06 edge): once ANY attempt on this
 * order - success or failure - has recorded a value on
 * order.custom.gbCustomerId, that value is treated as sticky for the rest of
 * the order's life rather than re-derived. gameballIdentity.getOrderCustomerId
 * is only deterministic under FIXED inputs: gameballGuestOrderMode and
 * gameballLinkGuestOrdersByLogin can both be changed by a merchant between
 * this order's first attempt and a later one, and a guest shopper can
 * register an account using the order's own email in the meantime (rung 2 of
 * the ladder then resolves to the new registered profile instead of the
 * original guest id). Re-deriving in that window would persist an identity
 * that does not match what Gameball's own transaction record for this
 * orderId is actually filed under - item 07's refund handoff reads
 * gbCustomerId verbatim and has no way to detect the mismatch (spec 05
 * section 9.1: "produces 7000 Customer Not Found or a refund credited to the
 * wrong profile").
 *
 * Falls back to the ladder only when nothing was ever recorded for this
 * order - its very first attempt, or one that failed before every branch
 * below persisted an identity.
 *
 * ARCHITECTURAL LIMIT this cannot close: orderPayload.build() (owned by item
 * 05, not edited here per arbitration section 4.5) always re-derives the
 * identity it actually POSTS by calling this same ladder itself - nothing in
 * its contract accepts a pinned identity from the caller. So a genuinely
 * fresh POST issued after the inputs above have drifted still goes out under
 * the newly-derived id regardless of what this function returns; this
 * function only controls what gets PERSISTED when settling a state that is
 * NOT a confirmed-fresh success (see sendOrder/attemptTrack call sites) -
 * which is exactly the case (Gameball confirming or the caller recording a
 * failure for a PRIOR attempt) where the stored value, not a new guess, is
 * the correct one to keep.
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
 * Narrows an ORDER-scope verdict for the specific "the POST may have landed,
 * verify before resending" signals build-plan section 5.5 exists to catch,
 * in the cases the shared classify() ladder (gameballErrors.js, frozen and
 * item-03-owned per arbitration section 4.9) cannot express: its HTTP-status
 * fallback and its result.status === 'SERVICE_UNAVAILABLE' branch are both
 * endpoint-agnostic by design, so neither can know that for the order-tracking
 * endpoint specifically "no envelope came back" means "cannot rule out that
 * the write happened" rather than "this definitely failed". Item 06 owns
 * exactly this narrowing (arbitration section 4.9's ownership row: "the
 * synthetic transport tokens ... and their AMBIGUOUS mapping"); it lives here,
 * in item 06's own file, rather than as an edit to classify()'s shared ladder,
 * so no other scope (CUSTOMER/DELETE/REFUND) is touched.
 *
 * Only ever NARROWS an already-computed verdict in place - never invents a
 * disposition classify() did not already produce, and never overrides a
 * verdict classify() built from an actual recovered Gameball {code,
 * requestId} envelope (a real Gameball code is always the more specific,
 * more trusted answer and is left completely alone).
 *
 * DELIBERATE READING of arbitration's own synthetic-token table: this
 * function does NOT route SVC_UNAVAILABLE to AMBIGUOUS, even though
 * arbitration section 4.9 lists it alongside the other six tokens under "their
 * AMBIGUOUS mapping". Build-plan section 4.4 / spec 06 section 7.1 - the
 * detailed, code-level design arbitration itself never revisits or contradicts
 * in its section 6 ruled-contradictions list - keeps SERVICE_UNAVAILABLE as
 * its own disposition specifically so a platform-side valve (SFCC's rate
 * limiter, an open circuit breaker, the service disabled in Business Manager)
 * halts the run WITHOUT burning the order's attempt budget (S26), which
 * retryFailedOrders.js's DISPOSITION.SERVICE_UNAVAILABLE branch already
 * implements. Collapsing it into AMBIGUOUS would make that branch dead code
 * and would burn an attempt on a failure that was never this order's fault.
 * Read as arbitration's one-line table cell generalising seven tokens it does
 * not itself analyse individually, not as a considered override of spec 06's
 * own detailed table - call this out explicitly in review.
 *
 * UNVERIFIED (no sandbox in this environment; build-plan section 4.4 and
 * arbitration risk R-1 both flag the exact spelling): whether
 * dw.svc.Result#unavailableReason actually contains the substring 'TIMEOUT'
 * on a genuine service timeout, as opposed to some other SFCC-internal token.
 * If it does not, every timeout falls into the SVC_UNAVAILABLE branch below
 * instead of TIMEOUT - safe either way (both still avoid a blind resend; see
 * the ruling above), but a real timeout then skips the verification probe
 * until the substring check is corrected on a sandbox.
 *
 * @param {dw.svc.Result} result - the raw Result, or null/undefined
 * @param {{disposition: string, code: string, requestId: string,
 *          message: string, httpStatus: (number|undefined)}} verdict -
 *   gameballErrors.classify()'s own output, mutated in place
 */
function narrowOrderAmbiguity(result, verdict) {
    if (!result) {
        // classify() already routes a missing Result to SERVICE_UNAVAILABLE
        // with no code at all (readEnvelope has nothing to recover from) - a
        // connection reset or a transport failure with no HTTP status
        // whatsoever. Never a Gameball answer, so nothing here overrides a
        // real code.
        verdict.disposition = DISPOSITION.AMBIGUOUS;
        verdict.code = 'NO_RESULT';
        return;
    }

    if (verdict.disposition === DISPOSITION.SERVICE_UNAVAILABLE && verdict.code === 'SERVICE_UNAVAILABLE') {
        // classify() matched result.status === 'SERVICE_UNAVAILABLE' via its
        // generic SFCC-transport branch, which does not distinguish WHY: a
        // genuine call timeout (the POST may have reached Gameball even
        // though the response never did) reads identically, at that layer, to
        // SFCC's own rate limiter or an open circuit breaker (the call never
        // left this instance). Only the former may have landed.
        var reason = '';
        try {
            reason = String(result.unavailableReason || '').toUpperCase();
        } catch (e) {
            reason = '';
        }

        if (reason.indexOf('TIMEOUT') !== -1) {
            verdict.disposition = DISPOSITION.AMBIGUOUS;
            verdict.code = 'TIMEOUT';
        } else {
            // Rename the generic literal to the abbreviated token
            // gameballErrors.js's ORDER scope table actually keys on (a
            // greppability fix, not a behaviour change - disposition stays
            // SERVICE_UNAVAILABLE either way), so a LATER run's
            // classifyStoredCode(..., ORDER_SCOPE) resolves this through that
            // table instead of only ever reaching the same answer via the
            // hardcoded SFCC_SERVICE_UNAVAILABLE literal match.
            verdict.code = 'SVC_UNAVAILABLE';
        }
        return;
    }

    if (verdict.disposition === DISPOSITION.TRANSIENT && verdict.httpStatus === 500 && verdict.code === '500') {
        // classify() recovered no Gameball envelope at all (readEnvelope
        // found no code/requestId) and fell all the way to its bare
        // HTTP-status ladder, which treats every 5xx alike. A BARE 500
        // specifically is the one status build-plan section 5.5 calls out as
        // ambiguous - unlike a 502/503/504, which are gateway/edge responses
        // that did not reach the Gameball application at all, a 500 can mean
        // the application received the request and failed AFTER acting on
        // it (spec 06 section 7.1 deliberately keeps 502/503/504 as
        // TRANSIENT and only 500 as AMBIGUOUS). verdict.code === '500'
        // (rather than checking httpStatus alone) guards against ever
        // overriding a verdict classify() built from an actual Gameball code
        // that happened to equal the numeral 500 - no such code exists in
        // section 13.8, but the equality check costs nothing and keeps this
        // override provably narrow.
        verdict.disposition = DISPOSITION.AMBIGUOUS;
        verdict.code = 'HTTP_500';
    }
}

/**
 * Writes any subset of the Gameball order attributes in ONE transaction.
 * A key set to null clears the attribute; a key that is undefined is not
 * written. gbLastError is truncated (see truncateError) so a giant proxy
 * error page can never blow past the attribute's length ceiling and throw
 * from inside this failure-persistence path itself (H20).
 * @param {dw.order.Order} order
 * @param {Object} attrs - any of gbTrackState, gbGameballOrderId, gbCustomerId,
 *   gbCustomerIdSource, gbLastError, gbLastErrorCode, gbLastRequestId,
 *   gbRetryAttempts, gbLastAttemptAt, gbNextRetryAt
 */
function persistResult(order, attrs) {
    Transaction.wrap(function () {
        if (attrs.gbTrackState !== undefined) {
            order.custom.gbTrackState = attrs.gbTrackState;
        }
        if (attrs.gbGameballOrderId !== undefined) {
            order.custom.gbGameballOrderId = attrs.gbGameballOrderId;
        }
        if (attrs.gbCustomerId !== undefined) {
            order.custom.gbCustomerId = attrs.gbCustomerId;
        }
        // Preserved verbatim from item 05 (arbitration section 4.3 requires
        // this block survive the restructure unchanged).
        if (attrs.gbCustomerIdSource !== undefined) {
            order.custom.gbCustomerIdSource = attrs.gbCustomerIdSource;
        }
        if (attrs.gbLastError !== undefined) {
            order.custom.gbLastError = attrs.gbLastError === null ? null : truncateError(attrs.gbLastError);
        }
        if (attrs.gbLastErrorCode !== undefined) {
            order.custom.gbLastErrorCode = attrs.gbLastErrorCode;
        }
        if (attrs.gbLastRequestId !== undefined) {
            order.custom.gbLastRequestId = attrs.gbLastRequestId;
        }
        if (attrs.gbRetryAttempts !== undefined) {
            order.custom.gbRetryAttempts = attrs.gbRetryAttempts;
        }
        if (attrs.gbLastAttemptAt !== undefined) {
            order.custom.gbLastAttemptAt = attrs.gbLastAttemptAt;
        }
        if (attrs.gbNextRetryAt !== undefined) {
            order.custom.gbNextRetryAt = attrs.gbNextRetryAt;
        }
    });
}

/**
 * One tracking attempt: builds the payload, POSTs integrations/orders exactly
 * once, then classifies the outcome. Persists NOTHING - the caller decides
 * how to settle, because the confirmation-page path (sendOrder, below) and
 * the retry job have different attempt-counting and terminal-state rules
 * (H38: "should we ever" and "have we already" stay apart from "what do we
 * do about it").
 *
 * Deliberately does NOT re-run orderSyncGate itself - every caller (sendOrder
 * below, and retryFailedOrders.js's processOne) evaluates the gate first and
 * only calls this once it has already decided the order should be sent, so
 * this function's only two failure sources are "the payload could not be
 * built" and "the POST did not succeed". Never throws.
 *
 * @param {dw.order.Order} order
 * @returns {{ok: boolean, disposition: string, code: string, requestId: string,
 *            message: string, httpStatus: (number|undefined), body: (Object|undefined)}}
 *   body is the exact payload sent, present only when orderPayload.build()
 *   succeeded (so a caller persisting gbGameballOrderId/gbCustomerId on
 *   success reads them from body, provably the values actually sent, never
 *   re-derived).
 */
function attemptTrack(order) {
    var body;

    try {
        body = orderPayload.build(order);
    } catch (buildError) {
        // orderSyncGate already guarantees a resolvable identity before this
        // is ever reached (H22 - guarded here anyway for a future caller that
        // might skip the gate). A build failure this late is therefore a
        // structural problem with the order itself (e.g. the payload
        // builder's own identity re-derivation disagreeing with the gate's,
        // which should be impossible since both call the same pure
        // gameballIdentity.getOrderCustomerId(order)) rather than a transient
        // one - PERMANENT is a direct, hard-coded verdict here, not a table
        // lookup, because no HTTP call was even attempted: "the POST may have
        // landed" (the entire justification for AMBIGUOUS/verify-before-
        // resend) cannot apply to a call that was never made.
        return {
            ok: false,
            disposition: DISPOSITION.PERMANENT,
            code: 'PAYLOAD_BUILD_FAILED',
            requestId: '',
            message: String((buildError && buildError.message) || 'Gameball order payload could not be built'),
            httpStatus: undefined,
            body: undefined
        };
    }

    try {
        var result = gameballService.call({
            path: 'integrations/orders',
            method: 'POST',
            body: body
        });

        var verdict = gameballErrors.classify(result, ORDER_SCOPE);
        narrowOrderAmbiguity(result, verdict);

        return {
            ok: verdict.disposition === DISPOSITION.SUCCESS || verdict.disposition === DISPOSITION.ALREADY_APPLIED,
            disposition: verdict.disposition,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message,
            httpStatus: verdict.httpStatus,
            body: body
        };
    } catch (e) {
        // An exception here means something failed AFTER gameballService.call()
        // was invoked - possibly after the bytes were already sent (a
        // malformed-response parse failure, for instance) - so the POST may
        // in fact have landed. Routed through classifyStoredCode rather than
        // a bare DISPOSITION.AMBIGUOUS literal so this file and
        // gameballErrors.js's ORDER scope table can never disagree about what
        // the EXCEPTION token means.
        return {
            ok: false,
            disposition: gameballErrors.classifyStoredCode('EXCEPTION', ORDER_SCOPE),
            code: 'EXCEPTION',
            requestId: '',
            message: String((e && e.message) || 'Unknown exception during Gameball order sync'),
            httpStatus: undefined,
            body: body
        };
    }
}

/**
 * Read-only check of whether Gameball already holds a reward transaction for
 * this orderId. Used before re-sending an order whose previous attempt was
 * AMBIGUOUS (timeout / connection fault / HTTP 500 / an exception after the
 * call returned), so a request that in fact succeeded is never POSTed twice
 * (build-plan section 5.5, "Never blind-retry").
 *
 * GET integrations/orders/{orderId}/transactions (build-plan section 13.6).
 * No body, no query string - gameballService.createRequest already returns
 * null when params.body is absent, so no change was needed there.
 *
 * @param {string} orderNo - the exact, case-preserved value sent as orderId.
 *   NEVER case-folded (build-plan section 13.3: orderId is case-sensitive).
 * @returns {boolean|null} true if Gameball reports at least one PaymentReward
 *   or AchievementReward transaction for this orderId; false if it reports
 *   none (or does not know the order); null if the probe itself failed and
 *   the caller must NOT assume either answer.
 */
function probeOrderTracked(orderNo) {
    try {
        if (!orderNo) {
            return null;
        }

        var result = gameballService.call({
            path: 'integrations/orders/' + encodeURIComponent(orderNo) + '/transactions',
            method: 'GET'
        });

        if (!result || !result.isOk()) {
            return null;
        }

        var body = null;
        try {
            body = typeof result.getObject === 'function' ? result.getObject() : null;
        } catch (readError) {
            body = null;
        }

        if (!body || typeof body !== 'object') {
            return null;
        }

        var count = parseInt(body.count, 10);
        if (isNaN(count) || count <= 0) {
            return false;
        }

        var transactions = body.transactions;
        if (!transactions || typeof transactions.length !== 'number') {
            // Gameball answered count > 0 but sent no array to confirm it -
            // an unexpected shape, not "zero transactions". Treated as
            // unknown (H18-style narrow default) rather than guessed either
            // way: false here would permit a caller to re-POST an order
            // Gameball may already hold, true would settle TRACKED on
            // nothing but a count.
            return null;
        }

        for (var i = 0; i < transactions.length; i++) {
            var type = transactions[i] && transactions[i].transactionType;
            // Only these two transactionType values mean "this order earned
            // points" (build-plan section 13.6). Refund, PartialRefund,
            // Cancel, Redemption, Migration, Expiry, Payment,
            // ManualAccumulation, DiscountCode and ManualDeduction do not.
            if (type === 'PaymentReward' || type === 'AchievementReward') {
                return true;
            }
        }

        return false;
    } catch (e) {
        Logger.error('Gameball order-tracked probe failed for order {0}: {1}', orderNo, e && e.message);
        return null;
    }
}

/**
 * Syncs one placed order to Gameball so the customer earns loyalty points.
 * Safe to call repeatedly (e.g. on every confirmation-page render) - the
 * gbTrackState custom attribute makes this idempotent, and orderSyncGate
 * covers every other reason an order should never be tracked (integration
 * off, replacement order, cancelled/failed order, or - while guest order
 * tracking is off or its mode is SKIP - a guest order).
 *
 * On a failure this now also classifies it (via attemptTrack) instead of
 * blanket-writing FAILED, so a permanently-bad first attempt (a malformed
 * payload, an invalid transaction time) settles FAILED_PERMANENT here and
 * NEVER enters the Gameball Order Retry job's candidate set at all - that
 * job only ever re-sends orders that stand a chance of succeeding.
 * @param {dw.order.Order} order - the placed SFCC order
 */
function sendOrder(order) {
    try {
        if (!order) {
            return;
        }

        // Terminal-state guard: never re-send an order that is already
        // TRACKED, or that has already been settled into one of the retry
        // job's never-retried terminal states. Without this, a confirmation
        // page carries no bound on how many times it can be reloaded
        // (refresh, back/forward, a bookmarked URL) and each reload issued a
        // fresh, live Gameball call for an order this cartridge had already
        // declared done with, in either direction - the metadata for
        // gbTrackState documents FAILED_PERMANENT and RETRY_EXHAUSTED as
        // "never retried", which this check is what actually makes true.
        var trackState = order.custom.gbTrackState;
        if (trackState === TRACK_STATE_TRACKED
                || trackState === TRACK_STATE_FAILED_PERMANENT
                || trackState === TRACK_STATE_RETRY_EXHAUSTED) {
            return;
        }

        // Backoff guard: a reload during the window a prior failed attempt
        // itself set (firstRetryAt, below, or the retry job's own
        // exponential ladder) waits it out rather than re-hammering Gameball
        // on every reload - the same field the retry job
        // (retryFailedOrders.js) reads before its own attempts, so a busy
        // confirmation page and the hourly job share one throttle instead of
        // each enforcing its own.
        var nextRetryAt = order.custom.gbNextRetryAt;
        if (nextRetryAt && nextRetryAt.getTime() > Date.now()) {
            return;
        }

        var gate = orderSyncGate.evaluate(order);
        if (!gate.shouldTrack) {
            // Avoid rewriting the same SKIPPED state (and triggering an
            // unnecessary order save) on every repeat view, e.g. a guest
            // order's confirmation page being reloaded.
            if (gate.skipState && order.custom.gbTrackState !== gate.skipState) {
                persistResult(order, {
                    gbTrackState: gate.skipState,
                    gbLastError: 'SKIPPED REASON: ' + gate.reason
                });
            }
            return;
        }

        // Reuse a previously-recorded identity rather than re-deriving one
        // (resolveAttemptIdentity, above) - spec 05 section 9.2, binding on
        // this item per arbitration section 1. On this order's very first
        // attempt order.custom.gbCustomerId is still empty, so this resolves
        // through the ladder exactly as before; a reload after a prior
        // FAILED attempt now reuses whatever that attempt recorded instead of
        // asking the ladder again.
        var identity = resolveAttemptIdentity(order);
        var priorAttempts = Number(order.custom.gbRetryAttempts) || 0;
        var outcome = attemptTrack(order);
        var now = new Date();

        // Moved from before the POST (pre-item-06) to after it: the check
        // now reads the exact body attemptTrack sent rather than a second,
        // separately-built one, and it still only fires on the path that
        // actually issues a call (outcome.body is only set once a payload
        // was built), so a repeatedly-reloaded SKIPPED confirmation page can
        // never spam it even while the gate is on.
        if (outcome.body && outcome.body.guest && !outcome.body.email && !outcome.body.mobile && isInfoLogEnabled()) {
            // Gated on gameballInfoLogEnabled per H28 - see isInfoLogEnabled() above.
            Logger.warn('Gameball guest order {0} has no email or mobile - Gameball channel merging can never reconcile this guest profile with a registered shopper', order.getOrderNo());
        }

        if (outcome.disposition === DISPOSITION.SUCCESS) {
            // A fresh 2xx: Gameball just recorded this order for the first
            // time under exactly what THIS call sent, so the payload's own
            // echoed customerId is the new ground truth and supersedes
            // anything stored from an earlier attempt - provably the value
            // actually sent (spec 05 section 9.1 - item 07's refund handoff
            // depends on this).
            persistResult(order, {
                gbTrackState: TRACK_STATE_TRACKED,
                gbGameballOrderId: outcome.body && outcome.body.orderId,
                gbCustomerId: outcome.body && outcome.body.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: null,
                gbLastErrorCode: null,
                gbLastRequestId: null,
                gbNextRetryAt: null,
                gbLastAttemptAt: now,
                gbRetryAttempts: priorAttempts + 1
            });
            return;
        }

        if (outcome.disposition === DISPOSITION.ALREADY_APPLIED) {
            // Gameball is confirming a transaction an EARLIER attempt
            // already created (9004 and its siblings, ORDER scope) - the
            // identity that attempt actually used is the ground truth here,
            // not whatever THIS re-send's independently re-derived payload
            // happened to carry (identity.customerId, not
            // outcome.body.customerId - see resolveAttemptIdentity's
            // ARCHITECTURAL LIMIT note above for why the payload itself can
            // still drift even though what gets persisted here does not).
            persistResult(order, {
                gbTrackState: TRACK_STATE_TRACKED,
                gbGameballOrderId: outcome.body && outcome.body.orderId,
                gbCustomerId: identity.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: null,
                gbLastErrorCode: null,
                gbLastRequestId: null,
                gbNextRetryAt: null,
                gbLastAttemptAt: now,
                gbRetryAttempts: priorAttempts + 1
            });
            return;
        }

        if (outcome.disposition === DISPOSITION.PERMANENT) {
            Logger.error('Gameball order sync permanently failed ({0}): code={1} requestId={2} message={3}',
                order.getOrderNo(), outcome.code, outcome.requestId, outcome.message);
            persistResult(order, {
                gbTrackState: TRACK_STATE_FAILED_PERMANENT,
                gbCustomerId: identity.customerId,
                gbCustomerIdSource: identity.source,
                gbLastError: outcome.message,
                gbLastErrorCode: outcome.code,
                gbLastRequestId: outcome.requestId,
                gbLastAttemptAt: now,
                gbRetryAttempts: priorAttempts + 1,
                gbNextRetryAt: null
            });
            return;
        }

        // Every other disposition (CONFIG, SERVICE_UNAVAILABLE, TRANSIENT,
        // AMBIGUOUS, or anything a future Gameball code falls through to)
        // stays FAILED and enters the Gameball Order Retry job's candidate
        // set. Only CONFIG and SERVICE_UNAVAILABLE skip the attempt counter
        // (S26, build-plan section 4.4: "do not burn the attempt budget on a
        // valve the platform closed" - a bad credential or an SFCC-side rate
        // limit/circuit breaker is not this order's fault). gbNextRetryAt is
        // set on every one of them, including CONFIG/SERVICE_UNAVAILABLE:
        // this is attempt 1's flat backoff, not the retry job's exponential
        // ladder, and it exists so the very next confirmation-page reload
        // (or a fast job run) does not immediately re-hammer a Gameball
        // outage or a bad key.
        var burnsAttempt = outcome.disposition !== DISPOSITION.CONFIG
            && outcome.disposition !== DISPOSITION.SERVICE_UNAVAILABLE;

        Logger.error('Gameball order sync failed ({0}): disposition={1} code={2} requestId={3} message={4}',
            order.getOrderNo(), outcome.disposition, outcome.code, outcome.requestId, outcome.message);

        // gbRetryAttempts is INCREMENTED from whatever was already stored,
        // never reset to a literal 1/0 - a CONFIG/SERVICE_UNAVAILABLE failure
        // that does not burn an attempt must not also ERASE attempts a prior
        // TRANSIENT/AMBIGUOUS failure already burned, or an order could cycle
        // through this branch indefinitely without ever reaching
        // gameballRetryMaxAttempts.
        persistResult(order, {
            gbTrackState: TRACK_STATE_FAILED,
            gbCustomerId: identity.customerId,
            gbCustomerIdSource: identity.source,
            gbLastError: outcome.message,
            gbLastErrorCode: outcome.code,
            gbLastRequestId: outcome.requestId,
            gbLastAttemptAt: now,
            gbRetryAttempts: burnsAttempt ? priorAttempts + 1 : priorAttempts,
            gbNextRetryAt: firstRetryAt()
        });
    } catch (e) {
        Logger.error('Exception in Gameball order sync ({0}): {1}', order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);

        try {
            if (order) {
                persistResult(order, {
                    gbTrackState: TRACK_STATE_FAILED,
                    gbLastError: String((e && e.message) || 'Unknown exception'),
                    // An exception this far outside the classified paths
                    // above (e.g. the gate or the identity ladder itself
                    // throwing) still gets a code, because that is the one
                    // thing that makes it visible to the retry job's stored-
                    // code classification instead of being read as an order
                    // that failed before this item shipped.
                    gbLastErrorCode: 'EXCEPTION'
                });
            }
        } catch (persistError) {
            Logger.error('Failed to persist Gameball failure state on order ({0}): {1}', order && order.getOrderNo ? order.getOrderNo() : 'unknown', persistError && persistError.message);
        }
    }
}

module.exports = {
    sendOrder: sendOrder,
    attemptTrack: attemptTrack,
    probeOrderTracked: probeOrderTracked,
    persistResult: persistResult
};
