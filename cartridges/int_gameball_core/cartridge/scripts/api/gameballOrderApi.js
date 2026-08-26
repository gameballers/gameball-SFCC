'use strict';

var Site = require('dw/system/Site');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_order_hooks');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var orderPayload = require('*/cartridge/models/payload/orderPayload');
var orderSyncGate = require('*/cartridge/scripts/order/orderSyncGate');
var gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');

var TRACK_STATE_TRACKED = 'TRACKED';
var TRACK_STATE_FAILED = 'FAILED';

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
 * Persists a subset of {gbTrackState, gbGameballOrderId, gbCustomerId,
 * gbCustomerIdSource, gbLastError} onto order.custom. Always runs inside a
 * Transaction, per SFCC write rules. Only keys present on `attrs` are
 * written.
 * @param {dw.order.Order} order
 * @param {Object} attrs
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
        if (attrs.gbCustomerIdSource !== undefined) {
            order.custom.gbCustomerIdSource = attrs.gbCustomerIdSource;
        }
        if (attrs.gbLastError !== undefined) {
            order.custom.gbLastError = attrs.gbLastError;
        }
    });
}

/**
 * Syncs one placed order to Gameball so the customer earns loyalty points.
 * Safe to call repeatedly (e.g. on every confirmation-page render) - the
 * gbTrackState custom attribute makes this idempotent, and orderSyncGate
 * covers every other reason an order should never be tracked (integration
 * off, replacement order, cancelled/failed order, or - while guest order
 * tracking is off or its mode is SKIP - a guest order).
 * @param {dw.order.Order} order - the placed SFCC order
 */
function sendOrder(order) {
    try {
        if (!order) {
            return;
        }

        // Idempotency: never re-send an order that has already been tracked.
        // This is what stops every confirmation-page reload from
        // double-awarding points - checked before anything else runs, and
        // before the gate, so a TRACKED order never re-enters the identity
        // ladder below.
        if (order.custom.gbTrackState === TRACK_STATE_TRACKED) {
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

        // Resolved once here, in addition to orderPayload.build()'s own
        // independent resolution, purely to recover `source` for
        // gbCustomerIdSource: the ladder is pure and deterministic, so both
        // calls return the same value, and this keeps the payload builder
        // self-contained and callable without the API layer (H22).
        // Rejected alternative: putting `source` on the payload object
        // itself - that object is JSON.stringify'd and POSTed to Gameball
        // verbatim, and source is a cartridge-internal detail Gameball has
        // no field for.
        var identity = gameballIdentity.getOrderCustomerId(order);
        var body = orderPayload.build(order);

        if (body.guest && !body.email && !body.mobile && isInfoLogEnabled()) {
            // Gated on gameballInfoLogEnabled per H28 - see isInfoLogEnabled()
            // above. Only fires on the path that actually issues a call, so
            // a repeatedly-reloaded SKIPPED confirmation page can never spam
            // it even while the gate is on.
            Logger.warn('Gameball guest order {0} has no email or mobile - Gameball channel merging can never reconcile this guest profile with a registered shopper', order.getOrderNo());
        }

        var result = gameballService.call({
            path: 'integrations/orders',
            method: 'POST',
            body: body
        });

        if (result.isOk()) {
            persistResult(order, {
                gbTrackState: TRACK_STATE_TRACKED,
                gbGameballOrderId: body.orderId,
                // Written from body.customerId, never from identity, so the
                // persisted value is provably the value actually sent (spec
                // 05 §9.1 - item 07's refund handoff depends on this).
                gbCustomerId: body.customerId,
                gbCustomerIdSource: identity.source
            });
        } else {
            Logger.error('Gameball order sync failed ({0}): {1}', order.getOrderNo(), result.errorMessage);
            persistResult(order, {
                gbTrackState: TRACK_STATE_FAILED,
                gbLastError: String(result.errorMessage || 'Unknown error')
            });
        }
    } catch (e) {
        Logger.error('Exception in Gameball order sync ({0}): {1}', order && order.getOrderNo ? order.getOrderNo() : 'unknown', e && e.message);

        try {
            if (order) {
                persistResult(order, {
                    gbTrackState: TRACK_STATE_FAILED,
                    gbLastError: String((e && e.message) || 'Unknown exception')
                });
            }
        } catch (persistError) {
            Logger.error('Failed to persist Gameball failure state on order ({0}): {1}', order && order.getOrderNo ? order.getOrderNo() : 'unknown', persistError && persistError.message);
        }
    }
}

module.exports = {
    sendOrder: sendOrder
};
