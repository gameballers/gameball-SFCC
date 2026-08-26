'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var gameballErrors = require('*/cartridge/scripts/util/gameballErrors');
var refundPayload = require('*/cartridge/models/payload/refundPayload');
var refundStateStore = require('*/cartridge/scripts/refund/refundStateStore');
var refundGate = require('*/cartridge/scripts/refund/refundGate');
var gameballJobPacer = require('*/cartridge/scripts/job/gameballJobPacer');

var DISPOSITION = gameballErrors.DISPOSITION;

// Every classify() call in this file is scoped to REFUND (arbitration
// section 4.9) so the 9000-9008 range resolves through gameballErrors.js's
// REFUND override table rather than the shared default table or ORDER's own
// (differently-mapped) 9003/9004 rows.
var REFUND_SCOPE = { scope: 'REFUND' };

// A PERMANENT verdict on one of these codes is routed to a human-reviewed
// MANUAL_REVIEW rather than a plain FAILED - build-plan section 7.6's own
// per-code table (section 7 of the item spec). Kept here, not in
// gameballErrors.js: which ledger STATE a disposition settles into is
// refund-domain business logic, not a property of the Gameball response
// itself, and arbitration section 4.9 restricts this item to adding ROWS to
// that shared, frozen table - not branching logic keyed on refund-specific
// state names it does not know about.
var MANUAL_REVIEW_CODES = { 9000: true, 9002: true, 9003: true, 9007: true, 3004: true };

// A PERMANENT verdict on one of these codes is an ALERT-worthy dead end -
// nothing for a human to decide between, the identifier is simply wrong and
// will never become valid on retry - so it settles straight to FAILED with
// an escalated (error-level, unconditional) log line rather than waiting in
// MANUAL_REVIEW for a decision that isn't there to make.
var ALERT_CODES = { 9005: true, 7000: true };

// Backoff ladder (build-plan section 7.5 / spec section 7.5): capped
// exponential, base 60s, ceiling 6h, no jitter. SFCC has no sleep (P12) and
// the only retry driver is the hourly Refund Detector job, so this schedule
// is coarse by construction - its job is to stop a CONFIG-class outage or a
// stuck TRANSIENT code from re-hammering Gameball every run for days, not
// to achieve fine-grained pacing.
var BACKOFF_BASE_SECONDS = 60;
var BACKOFF_MAX_SECONDS = 21600;

// Fixed backoff for a call SFCC's own platform refused (open circuit
// breaker, rate limiter) - deliberately NOT exponential and NOT
// attempt-based, because this disposition never increments gbAttempts
// either (S26): there is no "attempt number" driving it.
var SERVICE_UNAVAILABLE_BACKOFF_SECONDS = 300;

var DEFAULT_MAX_ATTEMPTS = 6;
var MAX_ATTEMPTS_CLAMP_MIN = 1;
var MAX_ATTEMPTS_CLAMP_MAX = 50;

/**
 * Reads gameballRefundMaxAttempts, clamped and defaulted - mirrors the
 * read-and-clamp helpers in retryFailedOrders.js/erasureDrain.js rather than
 * importing one of them: each of those is private to its own file, and a
 * cross-domain import for a four-line preference read is a stranger
 * dependency than the duplicate.
 * @returns {number}
 */
function readMaxAttempts() {
    try {
        var site = Site.getCurrent();
        if (!site) {
            return DEFAULT_MAX_ATTEMPTS;
        }

        var parsed = parseInt(site.getCustomPreferenceValue('gameballRefundMaxAttempts'), 10);
        if (isNaN(parsed) || parsed < MAX_ATTEMPTS_CLAMP_MIN || parsed > MAX_ATTEMPTS_CLAMP_MAX) {
            return DEFAULT_MAX_ATTEMPTS;
        }

        return parsed;
    } catch (e) {
        return DEFAULT_MAX_ATTEMPTS;
    }
}

/**
 * nextAttemptAt = now + min(base * 2^(attemptsAfter-1), ceiling) seconds.
 * @param {number} attemptsAfter - the attempt count AFTER this attempt
 * @returns {Date}
 */
function computeBackoff(attemptsAfter) {
    var exponent = attemptsAfter - 1;
    if (exponent < 0) {
        exponent = 0;
    }

    var seconds = BACKOFF_BASE_SECONDS * Math.pow(2, exponent);
    if (!isFinite(seconds) || seconds > BACKOFF_MAX_SECONDS) {
        seconds = BACKOFF_MAX_SECONDS;
    }

    return new Date(Date.now() + seconds * 1000);
}

/**
 * Reads one field out of a Gameball JSON response body, trying the 2xx
 * shape first (result.getObject()) and falling back to parsing
 * result.errorMessage - the non-2xx envelope, per the same two-shape reading
 * gameballErrors.js's own readEnvelope performs (drift D5: parseResponse
 * discards statusCode on the failure path today). Duplicated narrowly here,
 * rather than exported from gameballErrors.js, because this is reading a
 * DIFFERENT field for a DIFFERENT purpose (the response body's own echoed
 * refundTransactionId/gameballTransactionId, not the {code, requestId}
 * envelope classify() already extracts) - adding a general-purpose "read any
 * field" export to that frozen, item-03-owned module for one caller is a
 * worse trade than eight lines here.
 * @param {dw.svc.Result} result
 * @param {string} field
 * @returns {*} the field's value, or null when absent/unreadable
 */
function readResponseField(result, field) {
    try {
        var body = null;
        try {
            body = typeof result.getObject === 'function' ? result.getObject() : null;
        } catch (e) {
            body = null;
        }

        if (!body || typeof body !== 'object') {
            var text = '';
            try {
                text = String(result.errorMessage || '');
            } catch (e2) {
                text = '';
            }

            if (text) {
                try {
                    body = JSON.parse(text);
                } catch (e3) {
                    body = null;
                }
            }
        }

        if (body && typeof body === 'object' && body[field] !== undefined && body[field] !== null) {
            return body[field];
        }
    } catch (e) {
        return null;
    }

    return null;
}

/**
 * Settles a verdict into the ledger and returns the caller-facing outcome.
 * Every branch calls refundStateStore.settleEntry exactly once, so the
 * ledger and the return value can never disagree about what happened.
 * @param {dw.order.Order} order
 * @param {Object} entry
 * @param {{disposition: string, code: string, requestId: string, message: string}} verdict
 * @param {dw.svc.Result} result - the raw Result, so a SUCCESS/ALREADY_APPLIED
 *   settle can read the response body's own echoed gameballTransactionId
 *   (section 4.5) without this function re-deriving it from verdict, which
 *   carries only classify()'s frozen {code, requestId, message} envelope
 * @returns {{disposition: string, code: (string|null), requestId: (string|null), state: string}}
 */
function settleFromVerdict(order, entry, verdict, result) {
    var state;
    var outcome;

    if (verdict.disposition === DISPOSITION.SUCCESS || verdict.disposition === DISPOSITION.ALREADY_APPLIED) {
        state = verdict.disposition === DISPOSITION.SUCCESS ? 'SENT' : 'DUPLICATE';
        var gameballTransactionIdRaw = readResponseField(result, 'gameballTransactionId');
        outcome = {
            state: state,
            incrementAttempt: true,
            nextAttemptAt: null,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message,
            // Read as a string via String(v) - section 4.5 warns the type
            // varies between endpoints (a string on refund, a number on
            // cashback/manual). A 200 with an empty body is still success -
            // recorded as null, never a fabricated placeholder.
            gameballTransactionId: gameballTransactionIdRaw === null ? null : String(gameballTransactionIdRaw),
            acceptedAmount: entry.refundAmount
        };
    } else if (verdict.disposition === DISPOSITION.PERMANENT) {
        var codeKey = verdict.code;
        if (ALERT_CODES[codeKey]) {
            state = 'FAILED';
            Logger.error('ALERT Gameball refund {0} on order {1} permanently failed (code={2} requestId={3}): {4}',
                entry.refundTransactionId, order.getOrderNo(), verdict.code, verdict.requestId, verdict.message);
        } else if (MANUAL_REVIEW_CODES[codeKey]) {
            state = 'MANUAL_REVIEW';
        } else {
            state = 'FAILED';
        }

        outcome = {
            state: state,
            incrementAttempt: true,
            nextAttemptAt: null,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message
        };
    } else if (verdict.disposition === DISPOSITION.CONFIG) {
        // Entry stays PENDING (never FAILED) so it resumes the moment the
        // merchant fixes the key - section 7.4. The step aborts entirely on
        // this disposition; see detectRefunds.js.
        outcome = {
            state: 'PENDING',
            incrementAttempt: false,
            nextAttemptAt: null,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message
        };
        state = 'PENDING';
    } else if (verdict.disposition === DISPOSITION.SERVICE_UNAVAILABLE) {
        // A valve the PLATFORM closed (S26) - never burns the attempt
        // budget, fixed (not exponential) backoff.
        outcome = {
            state: 'PENDING',
            incrementAttempt: false,
            nextAttemptAt: new Date(Date.now() + SERVICE_UNAVAILABLE_BACKOFF_SECONDS * 1000),
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message
        };
        state = 'PENDING';
    } else {
        // TRANSIENT, AMBIGUOUS, or anything a future Gameball code falls
        // through to. Burns the attempt budget; settles FAILED outright
        // once gameballRefundMaxAttempts is spent rather than waiting for a
        // later run to notice (mirrors retryFailedOrders.js's own
        // exhaustion-in-the-same-settle shape).
        var attemptsAfter = (Number(entry.attempts) || 0) + 1;
        var maxAttempts = readMaxAttempts();

        if (attemptsAfter >= maxAttempts) {
            state = 'FAILED';
            outcome = {
                state: 'FAILED',
                incrementAttempt: true,
                nextAttemptAt: null,
                code: verdict.code,
                requestId: verdict.requestId,
                message: (verdict.message || '') + ' [exhausted after ' + attemptsAfter + ' attempt(s)]'
            };
        } else {
            state = 'PENDING';
            outcome = {
                state: 'PENDING',
                incrementAttempt: true,
                nextAttemptAt: computeBackoff(attemptsAfter),
                code: verdict.code,
                requestId: verdict.requestId,
                message: verdict.message
            };
        }
    }

    refundStateStore.settleEntry(order, entry.refundTransactionId, outcome);

    if (state === 'FAILED' || state === 'MANUAL_REVIEW') {
        Logger.error('Gameball refund {0} on order {1} settled {2} (disposition={3} code={4} requestId={5}): {6}',
            entry.refundTransactionId, order.getOrderNo(), state, verdict.disposition, verdict.code, verdict.requestId, verdict.message);
    } else {
        Logger.info('Gameball refund {0} on order {1} settled {2} (disposition={3} code={4} requestId={5})',
            entry.refundTransactionId, order.getOrderNo(), state, verdict.disposition, verdict.code, verdict.requestId);
    }

    return { disposition: verdict.disposition, code: verdict.code || null, requestId: verdict.requestId || null, state: state };
}

/**
 * One attempt at delivering one ledger entry: re-runs the gate, builds the
 * payload, POSTs integrations/transactions/refund exactly once, classifies,
 * and settles. Shared by the refund detector job and by
 * gameballRefundApi.submitRefund - the ONLY function in this item that ever
 * makes a Gameball refund HTTP call.
 *
 * Never throws (H17). Exactly one attempt per invocation - no sleeps, no
 * loops, no recursion (P12, S25): SFCC has no sleep, and the caller (the
 * hourly job, or a later submitRefund/deliverPending call) is the retry
 * driver.
 *
 * @param {dw.order.Order} order
 * @param {Object} entry - one gbRefundLedger entry (see refundStateStore.js)
 * @returns {{disposition: string, code: (string|null), requestId: (string|null), state: string}}
 *   disposition is a gameballErrors.DISPOSITION value, or the local literal
 *   'SKIPPED' when the gate refused and no HTTP call was made
 */
function deliverEntry(order, entry) {
    try {
        if (!order || !entry || !entry.refundTransactionId) {
            return { disposition: 'SKIPPED', code: null, requestId: null, state: entry ? entry.state : 'MANUAL_REVIEW' };
        }

        // Re-run the gate (section 5.6 step 2): a delivery can be attempted
        // an hour after the entry was recorded, and the world may have
        // moved - credentials removed, order state changed, another entry
        // on this order already pushed gbRefundState to FULL. Never trust
        // that "it was eligible when recorded" still holds.
        var gate = refundGate.evaluate(order, { full: entry.full === true, refundAmount: entry.refundAmount });

        if (!gate.shouldSend) {
            if (gate.reason === 'gameball_disabled' || gate.reason === 'refunds_disabled') {
                // Deliberately NO write (mirrors refundGate's own skipState:
                // null contract) - a switched-off integration must not
                // scribble state onto an entry that is still, in every
                // sense that matters, merely waiting.
                return { disposition: 'SKIPPED', code: gate.reason, requestId: null, state: entry.state };
            }

            if (gate.reason === 'order_not_tracked') {
                if (entry.state !== 'WAITING_FOR_ORDER') {
                    refundStateStore.settleEntry(order, entry.refundTransactionId, {
                        state: 'WAITING_FOR_ORDER',
                        incrementAttempt: false,
                        nextAttemptAt: null,
                        code: '',
                        requestId: '',
                        message: ''
                    });
                }
                return { disposition: 'SKIPPED', code: gate.reason, requestId: null, state: 'WAITING_FOR_ORDER' };
            }

            // gate.skipState's vocabulary is NOT the same as one entry's
            // ENTRY_STATE: 'FULL' is an ORDER-level rollup value (evaluate's
            // already_fully_refunded row), never a member of
            // refundStateStore.ENTRY_STATE. Writing it straight through as
            // THIS entry's own `state` would leave an invalid literal in the
            // ledger - and would happen to still get excluded from future
            // delivery only by accident (isTerminalState() is simply "not a
            // NON_TERMINAL_STATES key", so 'FULL' reads as terminal by
            // coincidence, not by design) - and would leak out of
            // submitRefund's synchronous path as an undocumented status
            // outside its own SENT|DUPLICATE|PENDING|WAITING_FOR_ORDER|
            // MANUAL_REVIEW|FAILED|REJECTED contract. Map it to SKIPPED: the
            // order-level gbRefundState is already correct (some other,
            // already-delivered entry is what pushed it to FULL, and
            // recomputeRollup re-derives that same value from the ledger on
            // every settle regardless of what this one entry's state is), so
            // this entry just needs a terminal state that means "never going
            // to be sent" without inventing a new one. MANUAL_REVIEW is left
            // untouched (it IS a real ENTRY_STATE) so an actual escalation
            // still reads as MANUAL_REVIEW on the entry, not SKIPPED.
            var settleState = gate.skipState === 'FULL' ? refundStateStore.ENTRY_STATE.SKIPPED : (gate.skipState || 'MANUAL_REVIEW');
            refundStateStore.settleEntry(order, entry.refundTransactionId, {
                state: settleState,
                incrementAttempt: false,
                nextAttemptAt: null,
                code: gate.reason,
                requestId: '',
                message: 'refund gate refused: ' + gate.reason
            });
            return { disposition: 'SKIPPED', code: gate.reason, requestId: null, state: settleState };
        }

        var body;
        try {
            body = refundPayload.build(order, entry);
        } catch (buildError) {
            Logger.error('Gameball refund {0} on order {1} could not build a payload: {2}',
                entry.refundTransactionId, order.getOrderNo(), buildError && buildError.message);
            refundStateStore.settleEntry(order, entry.refundTransactionId, {
                state: 'MANUAL_REVIEW',
                incrementAttempt: true,
                nextAttemptAt: null,
                code: 'PAYLOAD_BUILD_FAILED',
                requestId: '',
                message: String((buildError && buildError.message) || 'Gameball refund payload could not be built')
            });
            return { disposition: 'PERMANENT', code: 'PAYLOAD_BUILD_FAILED', requestId: null, state: 'MANUAL_REVIEW' };
        }

        var result = gameballService.call({
            path: 'integrations/transactions/refund',
            method: 'POST',
            body: body
        });

        var verdict = gameballErrors.classify(result, REFUND_SCOPE);

        // The one re-assertion gameballErrors.js's frozen classify() cannot
        // itself perform (section 4.9/7.2): a 9004 is ALREADY_APPLIED=success
        // only when the id the response echoes back - when it echoes one at
        // all - matches the id THIS entry actually sent. A different echoed
        // id means something re-derived a refundTransactionId instead of
        // replaying the stored one - the exact bug section 4.3 exists to
        // design out - and is escalated rather than trusted.
        if (verdict.disposition === DISPOSITION.ALREADY_APPLIED && verdict.code === '9004') {
            var echoed = readResponseField(result, 'refundTransactionId');
            if (echoed && String(echoed) !== entry.refundTransactionId) {
                verdict.disposition = DISPOSITION.PERMANENT;
                verdict.message = 'ALERT: Gameball 9004 echoed refundTransactionId ' + echoed
                    + ' which differs from the id this entry sent (' + entry.refundTransactionId + '). '
                    + (verdict.message || '');
            }
        }

        return settleFromVerdict(order, entry, verdict, result);
    } catch (e) {
        Logger.error('Gameball refund delivery threw for {0} on order {1}: {2}',
            entry && entry.refundTransactionId, order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);

        try {
            if (order && entry && entry.refundTransactionId) {
                var attemptsAfter = (Number(entry.attempts) || 0) + 1;
                refundStateStore.settleEntry(order, entry.refundTransactionId, {
                    state: 'PENDING',
                    incrementAttempt: true,
                    nextAttemptAt: computeBackoff(attemptsAfter),
                    code: 'EXCEPTION',
                    requestId: '',
                    message: String((e && e.message) || 'unknown exception during Gameball refund delivery')
                });
            }
        } catch (persistError) {
            Logger.error('Gameball refund delivery: failed to persist exception state for {0}: {1}',
                entry && entry.refundTransactionId, persistError && persistError.message);
        }

        return { disposition: DISPOSITION.TRANSIENT, code: 'EXCEPTION', requestId: null, state: 'PENDING' };
    }
}

/**
 * Delivers every deliverable entry on one order. Used by the refund
 * detector job's Pass B only - gameballRefundApi.submitRefund never calls
 * this, it calls deliverEntry directly for the one entry it just recorded.
 *
 * MUST only be called after the caller has already called
 * gameballJobPacer.start() for this run: each delivery attempt inside the
 * loop consults gameballJobPacer.tryAcquire()/isHalted() itself, so an order
 * with several pending entries cannot spend the WHOLE run's call budget on
 * its own backlog before the pacer gets a say (an order can carry up to
 * refundStateStore.LEDGER_MAX_ENTRIES pending entries in the pathological
 * case). Deliberately NOT threaded as a parameter: the pacer is one
 * account-scoped singleton for the whole cartridge (gameballJobPacer.js's
 * own module comment), and deliverEntry above never touches it precisely
 * because it is also reachable from a live storefront/merchant call where no
 * job has ever called start() - see that function's own JSDoc.
 *
 * attempted/delivered/pending/failed/skipped are mutually exclusive and
 * together account for every non-terminal entry the loop looked at: skipped
 * is incremented for an entry NEVER attempted this pass (backoff not yet
 * due, or still inside its WAITING_FOR_ORDER window); every other counter is
 * incremented for an entry that WAS attempted (an outbound HTTP call was
 * made), split by where it landed. Kept this explicit, rather than leaving a
 * caller to derive "still pending" as attempted-delivered-failed, so the
 * count in a run summary can never silently double up against `skipped`.
 *
 * @param {dw.order.Order} order
 * @param {number} orphanMaxHours - gameballRefundOrphanMaxHours, already
 *   clamped by the caller
 * @returns {{attempted: number, delivered: number, pending: number,
 *            failed: number, skipped: number, config: boolean}}
 */
function deliverPending(order, orphanMaxHours) {
    var summary = { attempted: 0, delivered: 0, pending: 0, failed: 0, skipped: 0, config: false };

    try {
        var ledger = refundStateStore.readLedger(order);
        if (!ledger) {
            return summary;
        }

        var now = Date.now();

        for (var i = 0; i < ledger.length; i++) {
            if (gameballJobPacer.isHalted()) {
                break;
            }

            var entry = ledger[i];

            try {
                if (!entry || (entry.state !== 'PENDING' && entry.state !== 'WAITING_FOR_ORDER')) {
                    continue; // eslint-disable-line no-continue
                }

                if (entry.nextAttemptAt) {
                    var nextAt = new Date(entry.nextAttemptAt).getTime();
                    if (!isNaN(nextAt) && nextAt > now) {
                        summary.skipped++;
                        continue; // eslint-disable-line no-continue
                    }
                }

                if (entry.state === 'WAITING_FOR_ORDER' && order.custom.gbTrackState !== 'TRACKED') {
                    var recordedAtMs = entry.recordedAt ? new Date(entry.recordedAt).getTime() : now;
                    var ageHours = (now - recordedAtMs) / 3600000;

                    if (ageHours > orphanMaxHours) {
                        refundStateStore.settleEntry(order, entry.refundTransactionId, {
                            state: 'SKIPPED',
                            incrementAttempt: false,
                            nextAttemptAt: null,
                            code: 'orphan_expired',
                            requestId: '',
                            message: 'order ' + order.getOrderNo() + ' was never tracked within ' + orphanMaxHours + ' hour(s); refund abandoned'
                        });
                        Logger.error('Gameball refund {0} on order {1} abandoned (orphan_expired): the order was never tracked within {2} hour(s)',
                            entry.refundTransactionId, order.getOrderNo(), orphanMaxHours);
                    }

                    // Sending blind while still untracked guarantees 9005 -
                    // never attempted here either way, whether abandoned
                    // just now or still inside its waiting window.
                    summary.skipped++;
                    continue; // eslint-disable-line no-continue
                }

                if (!gameballJobPacer.tryAcquire()) {
                    // Budget spent for this run - remaining entries (on this
                    // order and every order after it) stay exactly as they
                    // are and are picked up next run.
                    break;
                }

                summary.attempted++;
                var outcome = deliverEntry(order, entry);

                if (outcome.disposition === DISPOSITION.SUCCESS || outcome.disposition === DISPOSITION.ALREADY_APPLIED) {
                    summary.delivered++;
                } else if (outcome.disposition === DISPOSITION.CONFIG) {
                    summary.pending++;
                    summary.config = true;
                    gameballJobPacer.halt('CONFIG');
                    break;
                } else if (outcome.state === 'FAILED' || outcome.state === 'MANUAL_REVIEW') {
                    summary.failed++;
                } else {
                    // TRANSIENT/AMBIGUOUS/SERVICE_UNAVAILABLE, or a gate
                    // refusal that fired on THIS attempt (the world moved
                    // between the checks above and deliverEntry re-running
                    // the gate) - the entry was attempted and is still not
                    // terminal, which is "pending", not "never attempted".
                    summary.pending++;
                }
            } catch (entryError) {
                Logger.error('Gameball refund deliverPending: order {0} entry {1} threw: {2}',
                    order.getOrderNo(), entry && entry.refundTransactionId, entryError && entryError.message);
            }
        }
    } catch (e) {
        Logger.error('Gameball refund deliverPending failed for order {0}: {1}',
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
    }

    return summary;
}

module.exports = {
    deliverEntry: deliverEntry,
    deliverPending: deliverPending
};
