'use strict';

/**
 * The one disposition vocabulary for every Gameball response in the cartridge.
 *
 * These names are a frozen contract: the customer sync, the GDPR erasure
 * drain, the order-retry job and the refund detector all branch on them, and
 * three of those four are written against this file before they exist. Do not
 * rename a value, do not add one without agreeing it across all four, and do
 * not collapse TRANSIENT into SERVICE_UNAVAILABLE - they differ in exactly one
 * consequential way: SERVICE_UNAVAILABLE is a valve the PLATFORM closed (rate
 * limiter, open circuit breaker, timeout), so it must never burn a caller's
 * attempt budget, while TRANSIENT is Gameball saying "later" and legitimately
 * may.
 */
var DISPOSITION = {
    SUCCESS: 'SUCCESS',
    ALREADY_APPLIED: 'ALREADY_APPLIED',
    TRANSIENT: 'TRANSIENT',
    AMBIGUOUS: 'AMBIGUOUS',
    PERMANENT: 'PERMANENT',
    CONFIG: 'CONFIG',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
};

/**
 * The shared default table: every code whose meaning does not depend on which
 * endpoint produced it. Codes are from build-plan section 13.8, keyed as
 * STRINGS because they arrive as strings from a parsed JSON envelope and as
 * numbers from an HTTP status, and one lookup table cannot be both.
 *
 * remediation is appended to the operator-facing message when present. It
 * exists because several of these codes are merchant-configuration problems
 * that look identical to a transport failure in a log line, and an operator
 * reading gbLastSyncError in Business Manager has no other documentation to
 * hand.
 */
var DEFAULT_TABLE = {
    // --- Authentication and account state. Retrying cannot fix any of these,
    // and retrying a bad key across 20,000 records is how a cartridge gets its
    // Gameball account blacklisted. CONFIG is the signal to halt a whole run.
    '1000': { disposition: DISPOSITION.CONFIG, remediation: 'check the API Key in the gameball.http.api.cred Service Credential (User ID field)' },
    '1001': { disposition: DISPOSITION.CONFIG, remediation: 'Gameball High Security Mode requires the SecretKey on every call; fill in the Password field of the gameball.http.api.cred Service Credential' },
    '1002': { disposition: DISPOSITION.CONFIG, remediation: 'the configured Gameball credentials are not permitted to call this endpoint' },
    '6000': { disposition: DISPOSITION.CONFIG, remediation: 'the Gameball account is disabled - re-enable it in the Gameball dashboard' },
    '8000': { disposition: DISPOSITION.CONFIG, remediation: 'this feature is not available on the Gameball plan in use' },

    // --- Gameball says "later".
    // 2001 is the widget's own client-side upsert racing a server-side one
    // (build-plan section 6.4), which is a normal collision, not a defect.
    '2001': { disposition: DISPOSITION.TRANSIENT, remediation: '' },
    '5000': { disposition: DISPOSITION.TRANSIENT, remediation: '' },
    '5003': { disposition: DISPOSITION.TRANSIENT, remediation: '' },

    // --- Malformed or rejected request. Identical bytes fail identically every
    // time, so anything that retries on this disposition burns quota to no
    // purpose.
    '3000': { disposition: DISPOSITION.PERMANENT, remediation: '' },
    '3001': { disposition: DISPOSITION.PERMANENT, remediation: '' },
    '3003': { disposition: DISPOSITION.PERMANENT, remediation: '' },
    '3006': { disposition: DISPOSITION.PERMANENT, remediation: '' },
    '3013': { disposition: DISPOSITION.PERMANENT, remediation: '' },
    '3016': { disposition: DISPOSITION.PERMANENT, remediation: '' },

    // 3008 is the expected symptom of channel merging being switched off, and
    // of the B2B shared-email case (build-plan section 6.1). It is the single
    // most likely PERMANENT a real merchant will see, which is why it is the
    // one that ships with its fix written out.
    '3008': { disposition: DISPOSITION.PERMANENT, remediation: 'duplicate email - enable channel merging in the Gameball dashboard' },

    // Not reachable on an idempotent upsert. If it ever appears, something is
    // structurally wrong and repeating it hourly is noise, not diagnosis.
    '7000': { disposition: DISPOSITION.PERMANENT, remediation: '' },

    // Normal upsert semantics, never an error: the record is already on
    // Gameball's side, so the desired end state is the actual end state.
    '7001': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' }
};

/**
 * Per-scope overrides, consulted before DEFAULT_TABLE.
 *
 * The buckets are pre-created empty so a later item adds rows without
 * touching a structure another item owns - the alternative, each item creating
 * its own bucket, makes several separate changes contend on one object literal.
 * Ownership, which nobody may cross:
 *   CUSTOMER    - this item. Deliberately empty: for customer upserts the
 *                 default table IS the complete table, so an override here
 *                 would be a second copy of it waiting to drift.
 *   DELETE      - the GDPR erasure item: HTTP 404 and 7000 both mean SUCCESS
 *                 there, because "the record is already gone" is the goal.
 *   ORDER       - the order-retry item: the 9000-9008 range and the synthetic
 *                 transport tokens.
 *   REFUND      - the refund item, where 9003 diverges to MANUAL_REVIEW.
 *   REDEMPTION  - the Pay with Points item (08): 9006/9007/9008 as they
 *                 appear on a direct transactions/hold or
 *                 transactions/hold/{ref} call, which read differently than
 *                 the SAME codes on an order-tracking POST (see ORDER's own
 *                 9006 comment below).
 */
var SCOPE_TABLES = {
    CUSTOMER: {},

    // The GDPR erasure item. Both rows say the same thing in two vocabularies:
    // the customer is not in Gameball. On every other endpoint that is a
    // problem; here it is precisely the state the erasure request asked for, so
    // it settles the mandate rather than retrying it. '7000' is the row that
    // does the work - it is the vocabulary Gameball actually uses for Customer
    // Not Found, and it also silently and correctly absorbs the very common
    // case of a shopper who registered while gameballEnabled was off and was
    // therefore never synced at all.
    //
    // '404' is keyed as an HTTP status rather than a Gameball code, and
    // classify() applies it ONLY to a response that provably came from the
    // Gameball application - see the statusOverride branch there, which
    // requires a requestId. A bare 404 is deliberately NOT success. The delete
    // endpoint is a non-standard alias whose availability per account is
    // unverified, so "the customer is gone" and "this endpoint is not routed"
    // arrive at this table as the same status line; reading the second as the
    // first would report every mandate honoured, purge the tombstones seven
    // days later, and delete nobody. A false FAILED costs an operator one look
    // at the Gameball dashboard, a false SUCCESS costs the mandate and the only
    // record of it.
    DELETE: {
        '404': { disposition: DISPOSITION.SUCCESS, remediation: '' },
        '7000': { disposition: DISPOSITION.SUCCESS, remediation: '' }
    },

    // The order-retry item. Ownership is deliberately narrow: arbitration
    // restricts item 06 to exactly the 9000-9008 range plus its own synthetic
    // transport tokens - it does NOT extend DEFAULT_TABLE with the rest of the
    // 3xxx/6xxx/7xxx catalogue spec 06 itself enumerates, because most of
    // those rows are already owned by item 03 (see DEFAULT_TABLE above) and
    // the remainder (3002/3004/3005/.../6001/6002/7002-7006/etc.) have no
    // owner in this table and are left to the DEFAULT_TABLE-miss fail-safe
    // (unknown code -> TRANSIENT) rather than guessed at here. A code added
    // to DEFAULT_TABLE later automatically applies to every scope, ORDER
    // included, since scopeTable() is consulted first and only intercepts the
    // codes actually listed below.
    ORDER: {
        // 9000-9008 (build-plan section 13.8's order-tracking verification
        // range). 9004 is the flagship: it is the signal Gameball's own
        // idempotency guarantee rests on (a re-POST of the same orderId is
        // REJECTED, not silently re-applied) - see build-plan section 5.5's
        // "never blind-retry" guard and risk R-2 in arbitration section 8,
        // which is why item 07 inherits this row unchanged. 9001 and 9003 are
        // the sibling duplicate-signal codes ("already cancelled" /
        // "duplicate timestamp exists") and settle the same way: the order is
        // already on Gameball's side, which is the desired end state, so
        // re-sending it is success, not an error. None of the three are
        // reachable on order tracking today (order tracking has no cancel
        // path and orderDate is immutable per order, so a genuine duplicate
        // orderId/timestamp can only originate from THIS job re-sending its
        // own prior attempt) - they are classified anyway so item 07's refund
        // reuse and any future caller inherit a complete table rather than a
        // gap that silently falls through to "unknown -> retry forever".
        '9000': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        '9001': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' },
        '9002': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        '9003': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' },
        '9004': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' },
        // 9005 is singled out for a remediation string (build-plan section
        // 4.4): every other PERMANENT row in this range is either a data
        // problem intrinsic to the order or unreachable without the
        // redemption flow (Skip), but a reversed-transaction-not-found on a
        // PLAIN order-tracking POST is almost always a case mismatch between
        // the orderId this cartridge sent and what Gameball has stored, which
        // is exactly the kind of thing an operator can go fix.
        '9005': { disposition: DISPOSITION.PERMANENT, remediation: 'reversed transaction not found - almost always an orderId casing mismatch' },
        // 9006 (hold reference not found) and 9008 (insufficient point
        // balance) are reachable here on an order-tracking POST that carries
        // a redemption block (item 08, Pay with Points) - PERMANENT, same as
        // every other row in this range, because a stale/invalid hold
        // reference or an over-spent hold on order tracking is not
        // resendable as-is. Distinct from the REDEMPTION scope's own 9006
        // row below (ALREADY_APPLIED there): that one classifies a release
        // call against transactions/hold/{ref} directly, where "not found"
        // means the goal state is already true; here it means the order's
        // burn attempt itself was rejected.
        '9006': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // 9007 (invalid transaction time) - a far-past orderDate. Permanent
        // here; backfill of pre-cartridge orders is Skip, so there is no
        // future item that would need this reclassified.
        '9007': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // See the 9006 comment above - now reachable via item 08.
        '9008': { disposition: DISPOSITION.PERMANENT, remediation: '' },

        // Synthetic transport tokens - never a Gameball code, always something
        // THIS cartridge wrote to gbLastErrorCode because the live
        // dw.svc.Result could not be classified as a normal Gameball
        // response. classify() above (frozen, item-03-owned code per
        // arbitration section 4.9) cannot itself produce these - its
        // HTTP-status fallback and its result.status === 'SERVICE_UNAVAILABLE'
        // branch are both endpoint-agnostic and have no ORDER-specific notion
        // of "ambiguous". gameballOrderApi.js's narrowOrderAmbiguity()
        // (item 06's own file, not an edit to classify()) recognises the raw
        // dw.svc.Result shapes that mean "the POST may have landed" and
        // rewrites classify()'s verdict to the tokens below AFTER classify()
        // runs, so this table is where those rewritten tokens land on their
        // NEXT round-trip through classifyStoredCode:
        //   PROBE_FAILED and EXCEPTION are written directly by
        //     gameballOrderApi.js (a failed verification GET, and an
        //     exception raised after gameballService.call() returned) - never
        //     through narrowOrderAmbiguity.
        //   NO_RESULT (no dw.svc.Result at all), HTTP_500 (a bare 500 with no
        //     recovered Gameball envelope) and TIMEOUT (result.status ===
        //     'SERVICE_UNAVAILABLE' with an unavailableReason that reads as a
        //     timeout - see narrowOrderAmbiguity's own UNVERIFIED note on that
        //     substring check) are all narrowed to AMBIGUOUS.
        //   SVC_UNAVAILABLE is the one token that stays SERVICE_UNAVAILABLE,
        //     not AMBIGUOUS, even though arbitration section 4.9's one-line
        //     summary table lists it alongside the other six under "their
        //     AMBIGUOUS mapping" - see narrowOrderAmbiguity's own comment for
        //     why spec 06 section 7.1's detailed, code-level design (S26: a
        //     platform-side valve - SFCC's rate limiter, an open circuit
        //     breaker, the service disabled in BM - must halt the run WITHOUT
        //     burning the order's attempt budget) is followed here instead.
        //   PAYLOAD_BUILD_FAILED is the one deliberate exception in practice:
        //     gameballOrderApi.attemptTrack returns disposition PERMANENT
        //     directly (a hard-coded literal, not a lookup here) when
        //     orderPayload.build() throws, because no HTTP call was even
        //     attempted - "may have landed" cannot apply, and probing before
        //     resend would only waste a call. The row below exists so a
        //     STORED 'PAYLOAD_BUILD_FAILED' code re-classified on a later run
        //     (e.g. one written before this comment's reasoning was code, or
        //     entered by a human) still resolves to a safe, defined
        //     disposition rather than falling through to the generic
        //     unknown-code fail-safe.
        TIMEOUT: { disposition: DISPOSITION.AMBIGUOUS, remediation: '' },
        HTTP_500: { disposition: DISPOSITION.AMBIGUOUS, remediation: '' },
        SVC_UNAVAILABLE: { disposition: DISPOSITION.SERVICE_UNAVAILABLE, remediation: '' },
        PROBE_FAILED: { disposition: DISPOSITION.AMBIGUOUS, remediation: '' },
        PAYLOAD_BUILD_FAILED: { disposition: DISPOSITION.AMBIGUOUS, remediation: '' },
        EXCEPTION: { disposition: DISPOSITION.AMBIGUOUS, remediation: '' },
        NO_RESULT: { disposition: DISPOSITION.AMBIGUOUS, remediation: '' }
    },

    // The refund item. Ownership is exactly the 9000/9001/9002/9003/9004/
    // 9005/9007 range plus 3004 - nothing else is overridden here, so a code
    // this scope does not list (7000, 3000/3001/3003/3016, 1000-8000) falls
    // straight through to DEFAULT_TABLE above, unchanged. This table maps a
    // code to a DISPOSITION only. Which ledger entry state a PERMANENT
    // response settles into - a plain FAILED, or a human-reviewed
    // MANUAL_REVIEW - is refund-domain business logic and is NOT this file's
    // job to decide: that branching lives in refundDelivery.js, exactly as
    // retryFailedOrders.js already branches on ORDER-scope codes without this
    // file needing an opinion on any job's state machine.
    REFUND: {
        // 9000 Transaction non-reversible - PERMANENT here; refundDelivery.js
        // routes it to MANUAL_REVIEW (an operator judgement call, not a
        // guaranteed-forever failure like a malformed payload).
        '9000': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // 9001 Transaction already cancelled - the reversal already
        // happened, which is the desired end state, so this is
        // ALREADY_APPLIED = success, exactly like the ORDER scope's 9001 row
        // above (build-plan section 4.4 does not diverge this one).
        '9001': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' },
        // 9002 Transaction not found - PERMANENT; refundDelivery.js routes it
        // to MANUAL_REVIEW.
        '9002': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // 9003 Duplicate timestamp exists - the ORDER scope above maps this
        // to ALREADY_APPLIED (build-plan section 4.4). Refunds deliberately
        // do NOT inherit that mapping: this cartridge's transactionTime is
        // persisted at record time and replayed verbatim on every retry
        // (refundStateStore.js's allocateEntry), so a 9003 on a retry of the
        // SAME entry is genuinely ambiguous - it could mean this entry's
        // earlier attempt already landed, or that a DIFFERENT refund on this
        // account collided on the same timestamp and a real refund is about
        // to be silently dropped. Treating it as success risks the second;
        // treating it as dead risks the first. PERMANENT here, routed by
        // refundDelivery.js to MANUAL_REVIEW rather than FAILED, is the only
        // reading that cannot silently lose money. Resolved by build-plan
        // section 7.9 Q2 (transactionTime semantics), not before.
        '9003': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // 9004 Transaction ID already exists - the idempotency signal the
        // whole refund design leans on (see refundStateStore.js). Treated as
        // ALREADY_APPLIED = success EXCEPT when the response echoes a
        // DIFFERENT refundTransactionId than the one this entry actually
        // sent - that re-assertion needs the entry being delivered, which
        // this table has no way to see (classify()'s frozen signature is
        // (result, context) with no entry argument), so it lives in
        // refundDelivery.js, applied to this row's verdict immediately after
        // classify() returns.
        '9004': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' },
        // 9005 Reversed transaction not found - almost always a
        // reverseTransactionId casing mismatch, or credentials pointing at a
        // different Gameball workspace (test key vs live key) than the one
        // this order was originally tracked to. PERMANENT, and
        // refundDelivery.js alerts on it and settles it straight to FAILED
        // rather than MANUAL_REVIEW - there is nothing for a human to decide
        // between, the id is simply wrong and will never become findable.
        '9005': { disposition: DISPOSITION.PERMANENT, remediation: 'reversed transaction not found - almost always a reverseTransactionId casing mismatch, or credentials pointing at a different Gameball workspace than the one this order was tracked to' },
        // 9007 Invalid transaction time - PERMANENT; refundDelivery.js routes
        // it to MANUAL_REVIEW. This cartridge's transactionTime is stamped
        // once and replayed, so this means Gameball rejected the value
        // itself - likely build-plan section 7.9 Q2 (original-transaction
        // time vs refund-moment semantics) resolving against the assumption
        // this design makes.
        '9007': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // 3004 Operation unachievable - PERMANENT; refundDelivery.js routes
        // it to MANUAL_REVIEW.
        '3004': { disposition: DISPOSITION.PERMANENT, remediation: '' }
    },

    // Item 08 (Pay with Points). Ownership is exactly 9006/9007/9008 - calls
    // made directly against transactions/hold and transactions/hold/{ref},
    // as opposed to the ORDER scope's own 9006/9008 rows above, which
    // classify the SAME codes as they appear on an order-tracking POST that
    // carries a redemption block. The two readings differ on purpose (see
    // each row below), which is exactly why this needs its own bucket rather
    // than reusing ORDER's.
    REDEMPTION: {
        // Hold reference not found. On a DELETE (release) this is
        // unambiguous: the hold is already gone, which is the goal state a
        // release call wants, so it settles as success - mirrors the DELETE
        // scope's own 404/7000 -> SUCCESS pattern for GDPR erasure ("the
        // record is already gone" is the target state there too). This bucket
        // has no caller that issues a hold-create with a caller-supplied
        // reference, so there is no create-time reading of 9006 to weigh
        // against this one.
        '9006': { disposition: DISPOSITION.ALREADY_APPLIED, remediation: '' },
        // Invalid transaction time - our own stamped-at-call-time value was
        // rejected. A bug, not a user-fixable-by-retrying-the-same-amount
        // condition.
        '9007': { disposition: DISPOSITION.PERMANENT, remediation: '' },
        // Insufficient point balance - a normal declined-request outcome on
        // a hold-create, not a system failure. Classified PERMANENT (not
        // retryable as-is); the CALLER decides this means "tell the shopper
        // to pick a smaller amount" rather than logging at error level or
        // alerting - this file has no opinion on that, exactly as
        // refundDelivery.js already layers ledger-state business logic on
        // top of this file's plain dispositions for the REFUND scope above.
        '9008': { disposition: DISPOSITION.PERMANENT, remediation: '' }
    }
};

// SFCC's own transport verdict, read off dw.svc.Result#status when the call
// never reached Gameball at all. A named constant because it is matched as a
// string in two places and a typo would silently reclassify every timeout as
// an unknown failure.
var SFCC_SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

/**
 * @param {Object} [context] - the caller's classification context
 * @returns {Object} the override table for context.scope, or an empty object
 *          when the scope is absent or unrecognised. An unknown scope falls
 *          back to the shared table rather than throwing: a caller passing a
 *          typo should get a usable, conservative answer, not an exception on
 *          a path whose entire job is to handle failure.
 */
function scopeTable(context) {
    var scope = context && context.scope;
    if (scope && SCOPE_TABLES[scope]) {
        return SCOPE_TABLES[scope];
    }

    return {};
}

/**
 * Null/exception-safe read of one property off a dw.svc.Result.
 *
 * Every field this module reads is UNVERIFIED against a live instance (there is
 * no sandbox here), and several are documented only by inference. A getter that
 * throws or does not exist must produce "unknown", never take down the
 * classifier - which runs exclusively on paths that are already handling a
 * failure.
 *
 * @param {dw.svc.Result} result
 * @param {string} name
 * @returns {*} the value, or undefined
 */
function readField(result, name) {
    try {
        return result[name];
    } catch (e) {
        return undefined;
    }
}

/**
 * Null/exception-safe result.getObject().
 * @param {dw.svc.Result} result
 * @returns {*} the parsed body, or null
 */
function readObject(result) {
    try {
        if (typeof result.getObject !== 'function') {
            return null;
        }

        var body = result.getObject();
        return body === undefined ? null : body;
    } catch (e) {
        return null;
    }
}

/**
 * Coerces a value to an HTTP status number, or 0 when it is not one.
 *
 * dw.svc.Result#error carries the HTTP status for an HTTP service, but it also
 * carries service-framework error numbers on other paths, so the value is
 * range-checked rather than trusted. 0 means "no usable status", which reads
 * correctly at every call site because no real status is 0.
 *
 * @param {*} value
 * @returns {number}
 */
function toHttpStatus(value) {
    var status = parseInt(value, 10);
    if (isNaN(status) || status < 100 || status > 599) {
        return 0;
    }

    return status;
}

/**
 * Pulls Gameball's {code, requestId, message} envelope out of whatever shape
 * the service layer hands back.
 *
 * Two shapes are accepted on purpose. Today parseResponse returns the parsed
 * JSON body only and discards the HTTP status (known drift D5), so on a non-2xx
 * the envelope has to be recovered by parsing result.errorMessage back out. The
 * agreed fix returns {statusCode, text, retryAfter} instead. Handling both here
 * means that fix lands as a no-op in this file rather than as a coordinated
 * change across four callers - which is the only reason D5 can safely stay open
 * while four items depend on this classifier.
 *
 * UNVERIFIED (no sandbox in this environment): that errorMessage carries the
 * raw non-2xx body at all. If it does not, every code below collapses into the
 * HTTP-status-only fallback in classify(). That degradation is safe - nothing
 * becomes SUCCESS that was not - but it costs every fine distinction, so it is
 * the first thing to confirm on a sandbox.
 *
 * @param {dw.svc.Result} result
 * @returns {{code: string, requestId: string, message: string, httpStatus: number}}
 */
function readEnvelope(result) {
    var envelope = { code: '', requestId: '', message: '', httpStatus: 0 };
    var body = readObject(result);
    var text = '';

    if (body && typeof body === 'object' && body.statusCode !== undefined) {
        // Shape B (the corrected parseResponse): a wrapper carrying the status
        // and the raw text. Detected by the presence of statusCode rather than
        // by a version flag, so no coordination is needed on the day it lands.
        envelope.httpStatus = toHttpStatus(body.statusCode);
        text = String(body.text || '');
    } else if (body && typeof body === 'object') {
        // Shape A on a path where the body did parse: the envelope itself.
        if (body.code !== undefined && body.code !== null) {
            envelope.code = String(body.code);
        }
        if (body.requestId) {
            envelope.requestId = String(body.requestId);
        }
        if (body.message) {
            envelope.message = String(body.message);
        }
    } else if (typeof body === 'string') {
        text = body;
    }

    if (!envelope.code && !text) {
        // Shape A on the failure path: parseResponse does not run, and the raw
        // body surfaces as errorMessage.
        text = String(readField(result, 'errorMessage') || '');
    }

    if (text && !envelope.code) {
        try {
            var parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
                if (parsed.code !== undefined && parsed.code !== null) {
                    envelope.code = String(parsed.code);
                }
                if (parsed.requestId) {
                    envelope.requestId = String(parsed.requestId);
                }
                if (parsed.message) {
                    envelope.message = String(parsed.message);
                }
            }
        } catch (e) {
            // Not the documented JSON envelope - an HTML 503 from Gameball's
            // edge during an outage, or a proxy error page. The raw text is
            // kept as the message below so the operator sees SOMETHING; a body
            // that will not parse is never a reason to report no detail at all.
        }
    }

    if (!envelope.message) {
        envelope.message = text;
    }

    if (!envelope.httpStatus) {
        envelope.httpStatus = toHttpStatus(readField(result, 'error'));
    }

    return envelope;
}

/**
 * Maps an HTTP status to a disposition when no Gameball code was recoverable.
 *
 * This is the floor the whole design degrades to if result.errorMessage turns
 * out not to carry the response body. It keeps the three distinctions that
 * actually change behaviour - stop the run (CONFIG), stop retrying
 * (PERMANENT), try again (TRANSIENT) - and gives up the rest.
 *
 * @param {number} httpStatus
 * @returns {string|null} a DISPOSITION value, or null when the status says
 *          nothing useful
 */
function classifyHttpStatus(httpStatus) {
    if (!httpStatus) {
        return null;
    }

    if (httpStatus === 401 || httpStatus === 403) {
        return DISPOSITION.CONFIG;
    }

    if (httpStatus === 429 || httpStatus >= 500) {
        return DISPOSITION.TRANSIENT;
    }

    if (httpStatus >= 400) {
        return DISPOSITION.PERMANENT;
    }

    return null;
}

/**
 * Classifies a code persisted by a previous attempt, with no live Result.
 *
 * Exists so a retry path can decide what to do with a failure it did not
 * observe - the code was written to a custom attribute hours ago and the
 * dw.svc.Result is long gone. Same tables, same fail-safe.
 *
 * @param {string} code - a Gameball code, an HTTP status, or a synthetic
 *        transport token, as a string
 * @param {{scope: string}} [context]
 * @returns {string} a DISPOSITION value
 */
function classifyStoredCode(code, context) {
    var key = code === null || code === undefined ? '' : String(code);
    if (!key) {
        return DISPOSITION.TRANSIENT;
    }

    var override = scopeTable(context)[key];
    if (override) {
        return override.disposition;
    }

    var row = DEFAULT_TABLE[key];
    if (row) {
        return row.disposition;
    }

    if (key === SFCC_SERVICE_UNAVAILABLE) {
        return DISPOSITION.SERVICE_UNAVAILABLE;
    }

    var byStatus = classifyHttpStatus(toHttpStatus(key));
    if (byStatus) {
        return byStatus;
    }

    // Fail safe, not fail silent. An unrecognised code retries, and that is
    // self-limiting everywhere it is used: the customer sweep drops a profile
    // once it leaves the lookback window, and the retry job has an attempt
    // ceiling. Defaulting to PERMANENT was rejected - it would silently and
    // permanently drop every record hit by a code Gameball adds after this
    // table was written, with no symptom anywhere.
    return DISPOSITION.TRANSIENT;
}

/**
 * Classifies one Gameball response.
 *
 * Resolves the code down a ladder, because any rung can be the one that has an
 * answer: Gameball's own envelope code first (the only value that says WHY),
 * then the HTTP status, then SFCC's transport verdict for a call that never
 * reached Gameball. Never throws - it runs on paths that are already handling a
 * failure, and a classifier that throws converts a logged error into an
 * unhandled one.
 *
 * @param {dw.svc.Result} result
 * @param {{scope: string}} [context] - scope is 'CUSTOMER' | 'ORDER' |
 *        'REFUND' | 'DELETE'; omitted or unknown means the shared default table
 * @returns {{disposition: string, code: string, requestId: string,
 *            message: string, httpStatus: (number|undefined)}}
 */
function classify(result, context) {
    var verdict = {
        disposition: DISPOSITION.TRANSIENT,
        code: '',
        requestId: '',
        message: '',
        httpStatus: undefined
    };

    try {
        if (!result) {
            // No Result at all means the call never produced one, which from
            // the caller's point of view is indistinguishable from a timeout.
            verdict.disposition = DISPOSITION.SERVICE_UNAVAILABLE;
            verdict.message = 'no service result';
            return verdict;
        }

        var isOk = false;
        try {
            isOk = typeof result.isOk === 'function' && result.isOk();
        } catch (e) {
            isOk = false;
        }

        if (isOk) {
            verdict.disposition = DISPOSITION.SUCCESS;
            return verdict;
        }

        var envelope = readEnvelope(result);
        verdict.code = envelope.code;
        verdict.requestId = envelope.requestId;
        verdict.message = envelope.message;
        if (envelope.httpStatus) {
            verdict.httpStatus = envelope.httpStatus;
        }

        var row = scopeTable(context)[verdict.code] || DEFAULT_TABLE[verdict.code];
        if (verdict.code && row) {
            verdict.disposition = row.disposition;
            if (row.remediation) {
                verdict.message = verdict.message
                    ? verdict.message + ' [' + row.remediation + ']'
                    : row.remediation;
            }
            return verdict;
        }

        // Checked BEFORE the HTTP-status fallback: SFCC reports a rate-limited
        // or circuit-broken call with no HTTP status at all, and reports a
        // timeout with one that would otherwise read as a plain server error.
        // Both must land on SERVICE_UNAVAILABLE so a caller with an attempt
        // budget does not spend one on a valve the platform closed.
        var transportStatus = String(readField(result, 'status') || '');
        if (transportStatus === SFCC_SERVICE_UNAVAILABLE) {
            verdict.disposition = DISPOSITION.SERVICE_UNAVAILABLE;
            if (!verdict.code) {
                verdict.code = SFCC_SERVICE_UNAVAILABLE;
            }

            var reason = readField(result, 'unavailableReason');
            if (reason) {
                verdict.message = verdict.message
                    ? verdict.message + ' (' + String(reason) + ')'
                    : String(reason);
            }

            return verdict;
        }

        // The scope table is consulted a second time, keyed on the HTTP status,
        // BEFORE the shared status ladder below. One status can mean opposite
        // things at two endpoints: a 404 from a customer upsert is a broken
        // request, while a 404 from the erasure delete can be the goal state.
        // The ladder is endpoint-agnostic by construction and cannot express
        // that.
        //
        // Two conditions narrow it, and both are load-bearing rather than
        // defensive:
        //
        //   requestId must be present. Section 13.8 says every Gameball error
        //   carries code AND requestId, so a requestId is proof the Gameball
        //   APPLICATION answered. A gateway 404, a stale API version in the
        //   Service Credential URL, or an endpoint alias that is not routed on
        //   the account produces a 404 with an HTML or empty body and no
        //   requestId - and letting THAT reach a SUCCESS row would report every
        //   erasure honoured while deleting nobody, then purge the evidence.
        //   Such a response falls through to the ladder below and lands
        //   PERMANENT, which is the direction a compliance feature must err in.
        //
        //   code must be absent. If Gameball named a code, the code is the more
        //   specific answer and has already had its turn on the ladder above;
        //   overriding it with the bare status would, for instance, turn a
        //   route-level 4004 "resource not found" into "this customer is gone".
        var isGameballAnswer = !verdict.code && !!verdict.requestId;
        var statusOverride = (verdict.httpStatus && isGameballAnswer)
            ? scopeTable(context)[String(verdict.httpStatus)]
            : null;
        if (statusOverride) {
            verdict.disposition = statusOverride.disposition;
            if (!verdict.code) {
                verdict.code = String(verdict.httpStatus);
            }
            if (!verdict.message) {
                verdict.message = 'HTTP ' + verdict.httpStatus;
            }
            return verdict;
        }

        var byStatus = classifyHttpStatus(verdict.httpStatus);
        if (byStatus) {
            verdict.disposition = byStatus;
            if (!verdict.code) {
                verdict.code = String(verdict.httpStatus);
            }
            if (!verdict.message) {
                verdict.message = 'HTTP ' + verdict.httpStatus;
            }
            return verdict;
        }

        verdict.disposition = classifyStoredCode(verdict.code, context);
        if (!verdict.message) {
            verdict.message = 'no error message';
        }

        return verdict;
    } catch (e) {
        verdict.disposition = DISPOSITION.TRANSIENT;
        verdict.message = 'classification failed: ' + (e && e.message);
        return verdict;
    }
}

module.exports = {
    DISPOSITION: DISPOSITION,
    classify: classify,
    classifyStoredCode: classifyStoredCode
};
