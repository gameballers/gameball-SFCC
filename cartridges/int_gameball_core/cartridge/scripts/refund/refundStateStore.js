'use strict';

var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');

// Hard cap on how many refunds may ever be recorded against one order. NOT a
// preference - see docs/refunds-integration-guide.md and arbitration section
// 7 V-8: this ledger is an idempotency record, not a general-purpose queue,
// and its bound must stay a code constant so it can never be tuned into one.
// On overflow the refund is rejected to MANUAL_REVIEW, never truncated -
// truncating an old entry would delete the idempotency record for a refund
// ALREADY sent and let it be sent again (build-plan section 7.4's bug).
var LEDGER_MAX_ENTRIES = 25;

// gbRefundLastError / one entry's lastError budget. Same reasoning as
// gameballOrderApi.js's MAX_ERROR_LENGTH: an HTML error page from an
// intermediate proxy must never be able to blow past a string attribute's
// length ceiling and throw from inside this failure-persistence path itself
// (H20).
var MAX_ERROR_LENGTH = 200;
var MAX_REASON_LENGTH = 200;

// The complete state machine for one gbRefundLedger entry, spelled out here
// once so allocateEntry/settleEntry and every caller reads the same set of
// literals rather than re-typing them. NOT enum-of-string anywhere in this
// cartridge (H39) - every one of these is written from code, and an
// out-of-set write to enum-of-string throws on a path that must never throw.
var ENTRY_STATE = {
    WAITING_FOR_ORDER: 'WAITING_FOR_ORDER',
    PENDING: 'PENDING',
    SENT: 'SENT',
    DUPLICATE: 'DUPLICATE',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    FAILED: 'FAILED',
    SKIPPED: 'SKIPPED'
};

// The two states a not-yet-settled entry can be in - what allocateEntry ever
// creates, and what deliverPending's per-order scan below is looking for.
var NON_TERMINAL_STATES = {
    WAITING_FOR_ORDER: true,
    PENDING: true
};

/**
 * Truncates a value to maxLength characters, coercing null/undefined to ''
 * rather than the strings 'null'/'undefined'. Mirrors
 * gameballOrderApi.js's truncateError - duplicated rather than imported
 * because that helper is private to that file and pulling in the whole
 * order-tracking module for one four-line string helper would be a stranger
 * dependency than the four-line duplicate.
 * @param {*} value
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(value, maxLength) {
    var str = value === null || value === undefined ? '' : String(value);
    return str.length > maxLength ? str.substring(0, maxLength) : str;
}

/**
 * Parses order.custom.gbRefundLedger.
 *
 * A missing/empty value is a brand-new order with no refund history at all
 * and parses to [] - not an error. Anything present that will not parse as a
 * JSON array is the one condition this whole module treats as fatal: it
 * means either a hand edit in Business Manager or a genuinely corrupted
 * write, and proceeding past it would silently lose every idempotency record
 * already on the order (build-plan section 7.4's bug, the long way round).
 *
 * @param {dw.order.Order} order
 * @returns {Object[]|null} the parsed array, or null when present-but-unparseable
 */
function parseLedger(order) {
    var raw = order && order.custom ? order.custom.gbRefundLedger : null;
    if (!raw) {
        return [];
    }

    try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

/**
 * Public, read-only ledger accessor for callers OUTSIDE a transaction
 * (gameballRefundApi.js's submitRefund, the refund detector's Pass B).
 * allocateEntry/settleEntry below re-read and re-parse independently, inside
 * their own Transaction.wrap, rather than trusting a snapshot handed to them
 * by this function - a concurrent writer between the two calls is exactly
 * what allocateEntry's own re-check exists to catch.
 * @param {dw.order.Order} order
 * @returns {Object[]|null} entries, or null when gbRefundLedger will not parse
 */
function readLedger(order) {
    return parseLedger(order);
}

/**
 * @param {Object[]} ledger
 * @param {string} refundTransactionId
 * @returns {Object|null}
 */
function findById(ledger, refundTransactionId) {
    if (!ledger || !refundTransactionId) {
        return null;
    }

    for (var i = 0; i < ledger.length; i++) {
        if (ledger[i] && ledger[i].refundTransactionId === refundTransactionId) {
            return ledger[i];
        }
    }

    return null;
}

/**
 * @param {Object[]} ledger
 * @param {string} externalRefundId
 * @returns {Object|null}
 */
function findByExternalId(ledger, externalRefundId) {
    if (!ledger || !externalRefundId) {
        return null;
    }

    for (var i = 0; i < ledger.length; i++) {
        if (ledger[i] && ledger[i].externalRefundId === externalRefundId) {
            return ledger[i];
        }
    }

    return null;
}

/**
 * @param {string} state - one of ENTRY_STATE
 * @returns {boolean} true once an entry can never change state again
 */
function isTerminalState(state) {
    return !!state && !NON_TERMINAL_STATES[state];
}

/**
 * Mints the refundTransactionId for a NEW entry - build plan section 13.5 /
 * spec section 4.3's format table. Called ONLY from inside allocateEntry's
 * transaction, on the freshly-incremented seq, so this is the single place
 * in the whole item that computes an id - see the module comment on
 * allocateEntry for why that is load-bearing rather than a style choice.
 *
 * <prefix> is a uniqueness namespace only and carries NO protocol meaning -
 * unlike reverseTransactionId (read verbatim off gbGameballOrderId
 * elsewhere, in refundPayload.js), this value is never interpreted by
 * Gameball. Falling back to orderNo when gbGameballOrderId is still empty
 * exists only for a refund submitted before the order was ever tracked
 * (WAITING_FOR_ORDER) and is safe for exactly that reason.
 *
 * @param {dw.order.Order} order
 * @param {number} seq
 * @param {Object} spec - see allocateEntry
 * @returns {string}
 */
function mintRefundTransactionId(order, seq, spec) {
    var prefix = (order.custom.gbGameballOrderId && String(order.custom.gbGameballOrderId))
        || order.getOrderNo();

    if (spec.externalRefundId) {
        // Namespaced under the prefix rather than used raw (a deliberate
        // deviation from build-plan section 7.4's literal "takes
        // precedence" wording) so two DIFFERENT orders carrying the same OMS
        // reference cannot collide inside one Gameball workspace. The
        // property section 7.4 actually needs - full determinism, so the
        // same externalRefundId always yields the same id - is preserved
        // exactly: this is a pure function of order + externalRefundId.
        return prefix + '-X' + spec.externalRefundId;
    }

    if (spec.kind === 'CHARGEBACK') {
        return prefix + '-CB' + seq;
    }

    return prefix + '-R' + seq;
}

/**
 * Records ONE new refund against an order, or - for an externalRefundId
 * already on the ledger - returns the existing entry untouched.
 *
 * Every property build-plan section 7.4's double-award bug depends on is
 * enforced by doing all four of these INSIDE one Transaction.wrap, on values
 * re-read from the order rather than any value the caller might be holding
 * from before this call: (1) gbRefundSeq is read-then-incremented here, not
 * before; (2) the id is minted from that freshly-incremented value; (3) the
 * externalRefundId dedupe check runs again here, not only in the caller,
 * because a concurrent caller may have inserted between the caller's own
 * check and this one; (4) the entry is appended and gbRefundLedger written
 * in the same transaction as the seq increment. Two refunds recorded back to
 * back therefore always get distinct ids, whether or not either has been
 * delivered yet - see refundPayload.js's own JSDoc for why the DELIVERY path
 * must never re-derive an id.
 *
 * Contract: NEVER throws - a transaction failure (another process holding
 * the order) is caught and reported as error: 'CONCURRENT_MODIFICATION'
 * rather than propagated, so a caller like submitRefund can turn it into a
 * plain return value instead of an unhandled exception reaching a merchant's
 * webhook handler.
 *
 * @param {dw.order.Order} order
 * @param {Object} spec - {kind, full, refundAmount, externalRefundId,
 *   occurredAt, lineItems, reason, source, state}. state is
 *   'WAITING_FOR_ORDER' or 'PENDING' (default), decided by the caller from
 *   refundGate's verdict - this function does not itself run the gate.
 * @returns {{entry: (Object|null), created: boolean, error: (string|null)}}
 *   error is one of LEDGER_UNREADABLE | LEDGER_FULL | CONCURRENT_MODIFICATION
 */
function allocateEntry(order, spec) {
    var result = { entry: null, created: false, error: null };

    try {
        Transaction.wrap(function () {
            var ledger = parseLedger(order);

            if (ledger === null) {
                // Never overwrite an unparseable ledger (section 5.3 step 2)
                // - whatever is in there might still be somebody's
                // idempotency record. Only the order-level rollup is
                // touched, so a human sees MANUAL_REVIEW without this
                // function having destroyed the one thing that would let
                // them recover it.
                order.custom.gbRefundState = 'MANUAL_REVIEW';
                result.error = 'LEDGER_UNREADABLE';
                return;
            }

            if (spec.externalRefundId) {
                var existing = findByExternalId(ledger, spec.externalRefundId);
                if (existing) {
                    result.entry = existing;
                    result.created = false;
                    return;
                }
            }

            if (ledger.length >= LEDGER_MAX_ENTRIES) {
                order.custom.gbRefundState = 'MANUAL_REVIEW';
                result.error = 'LEDGER_FULL';
                return;
            }

            var seq = (Number(order.custom.gbRefundSeq) || 0) + 1;
            order.custom.gbRefundSeq = seq;

            var refundTransactionId = mintRefundTransactionId(order, seq, spec);
            var occurredAt = spec.occurredAt instanceof Date ? spec.occurredAt : new Date();
            var now = new Date();

            var entry = {
                refundTransactionId: refundTransactionId,
                transactionTime: occurredAt.toISOString(),
                kind: spec.kind || 'RETURN',
                full: spec.full === true,
                refundAmount: spec.full === true ? null : spec.refundAmount,
                lineItems: spec.full === true ? null : (spec.lineItems || null),
                externalRefundId: spec.externalRefundId || null,
                reason: spec.reason ? truncate(spec.reason, MAX_REASON_LENGTH) : null,
                source: spec.source || 'SUBMIT_REFUND',
                state: spec.state === 'WAITING_FOR_ORDER' ? ENTRY_STATE.WAITING_FOR_ORDER : ENTRY_STATE.PENDING,
                attempts: 0,
                nextAttemptAt: null,
                recordedAt: now.toISOString(),
                lastCode: null,
                lastRequestId: null,
                lastError: null,
                gameballTransactionId: null,
                acceptedAmount: null
            };

            ledger.push(entry);

            order.custom.gbRefundLedger = JSON.stringify(ledger);
            order.custom.gbRefundPendingAt = now;

            result.entry = entry;
            result.created = true;
        });
    } catch (e) {
        Logger.error('refundStateStore~allocateEntry: transaction failed for order {0}: {1}',
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
        return { entry: null, created: false, error: 'CONCURRENT_MODIFICATION' };
    }

    return result;
}

/**
 * Recomputes the order-level gbRefundState/gbRefundedAmount/gbRefundLastError
 * rollup from the WHOLE ledger. Called once, from inside settleEntry's own
 * transaction, every time any entry changes state - this is therefore always
 * a full recompute, never an incremental patch, which is what keeps it
 * correct no matter what order entries settle in.
 *
 * gbTrackedTotalPaid is read fresh off the order (never cached) because it
 * is gameballOrderApi.js's ceiling, written once at track time and never
 * touched by this module.
 *
 * @param {dw.order.Order} order
 * @param {Object[]} ledger
 * @returns {void}
 */
function recomputeRollup(order, ledger) {
    var trackedTotal = Number(order.custom.gbTrackedTotalPaid);
    var hasTrackedTotal = !isNaN(trackedTotal) && trackedTotal > 0;

    var anyManualReview = false;
    var anyFailed = false;
    var anyFullyAccepted = false;
    var refundedAmount = 0;
    var lastErrorText = null;
    var anyPending = false;

    for (var i = 0; i < ledger.length; i++) {
        var entry = ledger[i];
        if (!entry) {
            continue; // eslint-disable-line no-continue
        }

        if (entry.state === ENTRY_STATE.MANUAL_REVIEW) {
            anyManualReview = true;
            if (entry.lastError) {
                lastErrorText = entry.lastError;
            }
        } else if (entry.state === ENTRY_STATE.FAILED) {
            anyFailed = true;
            if (entry.lastError) {
                lastErrorText = entry.lastError;
            }
        } else if (entry.state === ENTRY_STATE.SENT || entry.state === ENTRY_STATE.DUPLICATE) {
            if (entry.full) {
                anyFullyAccepted = true;
                if (hasTrackedTotal) {
                    refundedAmount += trackedTotal;
                }
            } else if (typeof entry.refundAmount === 'number') {
                refundedAmount += entry.refundAmount;
            }
        }

        if (!isTerminalState(entry.state)) {
            anyPending = true;
        }
    }

    var newState;
    if (anyManualReview) {
        newState = 'MANUAL_REVIEW';
    } else if (anyFailed) {
        newState = 'FAILED';
    } else if (anyFullyAccepted || (hasTrackedTotal && refundedAmount >= trackedTotal)) {
        newState = 'FULL';
    } else if (refundedAmount > 0) {
        newState = 'PARTIAL';
    } else {
        newState = 'NONE';
    }

    order.custom.gbRefundState = newState;
    order.custom.gbRefundedAmount = refundedAmount;
    order.custom.gbRefundLastError = lastErrorText ? truncate(lastErrorText, MAX_ERROR_LENGTH) : null;

    if (!anyPending) {
        order.custom.gbRefundPendingAt = null;
    }
    // else: left completely untouched, per section 5.3 step 5 - there is no
    // "still pending" value to write, and touching it would bump the field
    // for no reason on every settle of an order carrying more than one entry.
}

/**
 * Patches one ledger entry with the outcome of a delivery attempt (or a
 * gate refusal) and recomputes the order-level rollup from the whole ledger.
 *
 * Contract: NEVER throws (H20 - the failure-persistence path must not itself
 * be able to fail the run/request).
 *
 * @param {dw.order.Order} order
 * @param {string} refundTransactionId
 * @param {Object} outcome - {state, incrementAttempt, nextAttemptAt, code,
 *   requestId, message, gameballTransactionId, acceptedAmount}
 * @returns {boolean} true when the entry was found and patched
 */
function settleEntry(order, refundTransactionId, outcome) {
    var found = false;

    try {
        Transaction.wrap(function () {
            var ledger = parseLedger(order);

            if (ledger === null) {
                // The ledger was readable when allocateEntry wrote this
                // entry and is not readable now - something else rewrote it
                // between then and this call. Do NOT attempt to reconstruct
                // or re-append; that would fabricate an idempotency record
                // this module never actually wrote. Escalate and stop.
                Logger.error('refundStateStore~settleEntry: gbRefundLedger on order {0} no longer parses; refusing to settle {1}',
                    order && order.getOrderNo ? order.getOrderNo() : 'unknown', refundTransactionId);
                order.custom.gbRefundState = 'MANUAL_REVIEW';
                return;
            }

            var entry = findById(ledger, refundTransactionId);
            if (!entry) {
                // Missing, not re-appended (section 5.3 step 2) - something
                // else rewrote the ledger and dropped this entry; fabricating
                // a replacement here would hide that rather than surface it.
                Logger.error('refundStateStore~settleEntry: entry {0} not found on order {1}; nothing settled',
                    refundTransactionId, order && order.getOrderNo ? order.getOrderNo() : 'unknown');
                return;
            }

            found = true;

            entry.state = outcome.state;
            entry.attempts = (Number(entry.attempts) || 0) + (outcome.incrementAttempt ? 1 : 0);
            entry.nextAttemptAt = outcome.nextAttemptAt instanceof Date ? outcome.nextAttemptAt.toISOString() : null;
            entry.lastCode = outcome.code || null;
            entry.lastRequestId = outcome.requestId || null;
            entry.lastError = outcome.message ? truncate(outcome.message, MAX_ERROR_LENGTH) : null;

            if (outcome.gameballTransactionId !== undefined) {
                entry.gameballTransactionId = outcome.gameballTransactionId;
            }
            if (outcome.acceptedAmount !== undefined) {
                entry.acceptedAmount = outcome.acceptedAmount;
            }

            recomputeRollup(order, ledger);

            order.custom.gbRefundLedger = JSON.stringify(ledger);
        });
    } catch (e) {
        Logger.error('refundStateStore~settleEntry: transaction failed for {0} on order {1}: {2}',
            refundTransactionId, order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);
        return false;
    }

    return found;
}

/**
 * Sets an order's rollup state directly, with NO ledger entry involved - the
 * one gbRefund* write this module performs outside allocateEntry/
 * settleEntry, for callers that need to record an order-level judgement
 * without recording or settling any individual refund. Two callers, both
 * narrow:
 *  - the refund detector's PARTIAL-then-cancelled guard (section 5.2 step
 *    5): "a partial refund already happened and now the order is
 *    cancelled" has no entry to allocate, only an escalation to MANUAL_REVIEW
 *    to record;
 *  - gameballRefundApi.submitRefund persisting a refundGate skipState
 *    (MANUAL_REVIEW or FULL) when the gate refuses BEFORE any entry is ever
 *    allocated (section 5.1 step 6).
 *
 * This module is the SOLE writer of every Order.custom.gbRefund* attribute
 * (this file's own module comment / spec section 2) - callers that need to
 * set gbRefundState directly must come through here rather than reaching
 * for Transaction.wrap themselves, so that rule has no exception in
 * practice.
 *
 * A no-op (no write, no transaction) when the order already reads the
 * requested state, matching persistResult-style idioms elsewhere in this
 * cartridge that avoid an unnecessary order save on a repeat call.
 *
 * Contract: NEVER throws.
 *
 * @param {dw.order.Order} order
 * @param {string} state - a gbRefundState value (NONE|PARTIAL|FULL|MANUAL_REVIEW|FAILED)
 * @param {string} reason - short machine-readable reason, logged only (not
 *   persisted anywhere - gbRefundLastError is entry-driven and this call has
 *   no entry)
 * @returns {void}
 */
function setRollupState(order, state, reason) {
    try {
        if (!order || !state || order.custom.gbRefundState === state) {
            return;
        }

        Transaction.wrap(function () {
            order.custom.gbRefundState = state;
        });

        Logger.warn('refundStateStore~setRollupState: order {0} set to {1} ({2})',
            order.getOrderNo(), state, reason || 'unspecified');
    } catch (e) {
        Logger.error('refundStateStore~setRollupState: could not set order {0} to {1}: {2}',
            order && order.getOrderNo ? order.getOrderNo() : 'unknown', state, e && e.message);
    }
}

module.exports = {
    readLedger: readLedger,
    findById: findById,
    findByExternalId: findByExternalId,
    isTerminalState: isTerminalState,
    allocateEntry: allocateEntry,
    settleEntry: settleEntry,
    setRollupState: setRollupState,
    LEDGER_MAX_ENTRIES: LEDGER_MAX_ENTRIES,
    ENTRY_STATE: ENTRY_STATE
};
