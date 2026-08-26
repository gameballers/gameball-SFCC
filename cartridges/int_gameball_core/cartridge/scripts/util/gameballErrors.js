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
 * The four buckets are pre-created empty so a later item adds rows without
 * touching a structure another item owns - the alternative, each item creating
 * its own bucket, makes four separate changes contend on one object literal.
 * Ownership, which nobody may cross:
 *   CUSTOMER - this item. Deliberately empty: for customer upserts the default
 *              table IS the complete table, so an override here would be a
 *              second copy of it waiting to drift.
 *   DELETE   - the GDPR erasure item: HTTP 404 and 7000 both mean SUCCESS
 *              there, because "the record is already gone" is the goal.
 *   ORDER    - the order-retry item: the 9000-9008 range and the synthetic
 *              transport tokens.
 *   REFUND   - the refund item, where 9003 diverges to MANUAL_REVIEW.
 */
var SCOPE_TABLES = {
    CUSTOMER: {},
    DELETE: {},
    ORDER: {},
    REFUND: {}
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
