'use strict';

var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var gameballErrors = require('*/cartridge/scripts/util/gameballErrors');
var redemptionPayload = require('*/cartridge/models/payload/redemptionPayload');

var DISPOSITION = gameballErrors.DISPOSITION;

// Every classify() call in this file is scoped to REDEMPTION (see
// gameballErrors.js's own module comment) so 9006/9007/9008 resolve through
// that scope's override table, not the ORDER scope's reading of the same
// three codes on an order-tracking call.
var REDEMPTION_SCOPE = { scope: 'REDEMPTION' };

/**
 * Reads the JSON body off a dw.svc.Result, guarded (H18) - the same
 * defensive shape gameballErrors.js's own readObject() uses internally, but
 * this module needs the body itself (not just a classification), so it is
 * duplicated rather than exported from that file for one three-line helper
 * (mirrors the resolveAttemptIdentity/isGameballEnabled duplication pattern
 * already established elsewhere in this cartridge).
 * @param {dw.svc.Result} result
 * @returns {Object|null}
 */
function readBody(result) {
    try {
        if (!result || typeof result.getObject !== 'function') {
            return null;
        }
        var body = result.getObject();
        return body && typeof body === 'object' ? body : null;
    } catch (e) {
        return null;
    }
}

/**
 * GET customers/{customerId}/balance.
 *
 * Storefront-called (Gameball-RedeemState), so this issues at most the one
 * call the route makes (P5) - no retry, no probe.
 *
 * @param {string} customerId - already-resolved, registered customerId
 * @returns {{ok: boolean, disposition: string, body: (Object|undefined),
 *            code: string, requestId: string, message: string}}
 */
function getBalance(customerId) {
    try {
        var result = gameballService.call({
            path: 'integrations/customers/' + encodeURIComponent(customerId) + '/balance',
            method: 'GET'
        });

        var verdict = gameballErrors.classify(result, REDEMPTION_SCOPE);
        var ok = verdict.disposition === DISPOSITION.SUCCESS;

        return {
            ok: ok,
            disposition: verdict.disposition,
            body: ok ? (readBody(result) || undefined) : undefined,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message
        };
    } catch (e) {
        Logger.error('gameballRedemptionApi~getBalance failed for customer {0}: {1}', customerId, e && e.message);
        return {
            ok: false,
            disposition: DISPOSITION.SERVICE_UNAVAILABLE,
            body: undefined,
            code: 'EXCEPTION',
            requestId: '',
            message: String((e && e.message) || 'Unknown exception fetching Gameball balance')
        };
    }
}

/**
 * POST transactions/hold. One call, never retried from this module (P12 -
 * there is no sleep, and no idempotency key exists on this endpoint to make
 * a blind retry safe - see redemptionPayload.js's own module comment).
 *
 * @param {string} customerId - already-resolved, registered customerId
 * @param {number} pointsToHold
 * @param {Object} [options] - see redemptionPayload.buildHoldRequest
 * @returns {{ok: boolean, disposition: string,
 *            body: ({holdAmount: number, holdEquivalentPoints: number, holdReference: string}|undefined),
 *            code: string, requestId: string, message: string}}
 */
function createHold(customerId, pointsToHold, options) {
    try {
        var body = redemptionPayload.buildHoldRequest(customerId, pointsToHold, options);

        var result = gameballService.call({
            path: 'integrations/transactions/hold',
            method: 'POST',
            body: body
        });

        var verdict = gameballErrors.classify(result, REDEMPTION_SCOPE);
        var ok = verdict.disposition === DISPOSITION.SUCCESS;

        var rawBody = ok ? readBody(result) : null;
        var mappedBody = undefined;
        if (rawBody) {
            mappedBody = {
                holdAmount: Number(rawBody.amount) || Number(rawBody.holdAmount) || 0,
                holdEquivalentPoints: Number(rawBody.holdPoints) || Number(rawBody.holdEquivalentPoints) || 0,
                holdReference: rawBody.holdReference
            };
        }

        return {
            ok: ok,
            disposition: verdict.disposition,
            body: mappedBody,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message
        };
    } catch (e) {
        Logger.error('gameballRedemptionApi~createHold failed for customer {0}: {1}', customerId, e && e.message);
        return {
            ok: false,
            disposition: DISPOSITION.SERVICE_UNAVAILABLE,
            body: undefined,
            code: 'EXCEPTION',
            requestId: '',
            message: String((e && e.message) || 'Unknown exception creating Gameball hold')
        };
    }
}

/**
 * DELETE transactions/hold/{ref}. No body (build-plan section 13.6). A 9006
 * (hold reference not found) classifies ALREADY_APPLIED under the
 * REDEMPTION scope - see gameballErrors.js's own comment - so a caller
 * releasing an already-gone hold sees `ok: true` here, not a failure.
 *
 * @param {string} holdReference
 * @returns {{ok: boolean, disposition: string, code: string, requestId: string, message: string}}
 */
function releaseHold(holdReference) {
    try {
        var result = gameballService.call({
            path: 'integrations/transactions/hold/' + encodeURIComponent(holdReference),
            method: 'DELETE'
        });

        var verdict = gameballErrors.classify(result, REDEMPTION_SCOPE);
        var ok = verdict.disposition === DISPOSITION.SUCCESS || verdict.disposition === DISPOSITION.ALREADY_APPLIED;

        return {
            ok: ok,
            disposition: verdict.disposition,
            code: verdict.code,
            requestId: verdict.requestId,
            message: verdict.message
        };
    } catch (e) {
        Logger.error('gameballRedemptionApi~releaseHold failed for hold {0}: {1}', holdReference, e && e.message);
        return {
            ok: false,
            disposition: DISPOSITION.SERVICE_UNAVAILABLE,
            code: 'EXCEPTION',
            requestId: '',
            message: String((e && e.message) || 'Unknown exception releasing Gameball hold')
        };
    }
}

module.exports = {
    getBalance: getBalance,
    createHold: createHold,
    releaseHold: releaseHold
};
