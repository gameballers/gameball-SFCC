'use strict';

var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_order_hooks');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var orderPayload = require('*/cartridge/models/payload/orderPayload');
var orderSyncGate = require('*/cartridge/scripts/order/orderSyncGate');

var TRACK_STATE_TRACKED = 'TRACKED';
var TRACK_STATE_FAILED = 'FAILED';

/**
 * Persists a subset of {gbTrackState, gbGameballOrderId, gbCustomerId,
 * gbLastError} onto order.custom. Always runs inside a Transaction, per SFCC
 * write rules. Only keys present on `attrs` are written.
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
 * off, guest order, replacement order, cancelled/failed order).
 * @param {dw.order.Order} order - the placed SFCC order
 */
function sendOrder(order) {
    try {
        if (!order) {
            return;
        }

        // Idempotency: never re-send an order that has already been tracked.
        // This is what stops every confirmation-page reload from
        // double-awarding points - checked before anything else runs.
        if (order.custom.gbTrackState === TRACK_STATE_TRACKED) {
            return;
        }

        var gate = orderSyncGate.evaluate(order);
        if (!gate.shouldTrack) {
            // Avoid rewriting the same SKIPPED state (and triggering an
            // unnecessary order save) on every repeat view, e.g. a guest
            // order's confirmation page being reloaded.
            if (gate.skipState && order.custom.gbTrackState !== gate.skipState) {
                persistResult(order, { gbTrackState: gate.skipState });
            }
            return;
        }

        var body = orderPayload.build(order);

        var result = gameballService.call({
            path: 'integrations/orders',
            method: 'POST',
            body: body
        });

        if (result.isOk()) {
            persistResult(order, {
                gbTrackState: TRACK_STATE_TRACKED,
                gbGameballOrderId: body.orderId,
                gbCustomerId: body.customerId
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
