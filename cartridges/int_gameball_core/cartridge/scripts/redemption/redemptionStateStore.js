'use strict';

var Site = require('dw/system/Site');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.service');

// Not a real dw.campaign.Promotion id - createPriceAdjustment() requires a
// non-empty, unique-per-basket promotion id string but this discount is
// never tied to an actual Promotion object (build-plan section 8.4 rejects a
// promotion-engine-integrated design for exactly this redemption path). H7:
// a magic string becomes a named constant.
var GAMEBALL_REDEMPTION_PROMOTION_ID = 'gameballPointsRedemption';

var DEFAULT_ASSUMED_TTL_MINUTES = 30;

/**
 * gameballRedemptionAssumedHoldTtlMinutes, clamped to a sane positive value.
 * COSMETIC ONLY (see the site preference's own description) - never used for
 * release or enforcement, only for the countdown persisted alongside the
 * hold.
 * @returns {number}
 */
function assumedTtlMinutes() {
    try {
        var parsed = parseInt(Site.getCurrent().getCustomPreferenceValue('gameballRedemptionAssumedHoldTtlMinutes'), 10);
        return isNaN(parsed) || parsed <= 0 ? DEFAULT_ASSUMED_TTL_MINUTES : parsed;
    } catch (e) {
        return DEFAULT_ASSUMED_TTL_MINUTES;
    }
}

/**
 * Finds the order-level PriceAdjustment this module created, if any, on a
 * Basket or an Order (both are dw.order.LineItemCtnr).
 * @param {dw.order.LineItemCtnr} basket
 * @returns {dw.order.PriceAdjustment|null}
 */
function findAdjustment(basket) {
    try {
        var adjustments = basket.getPriceAdjustments();
        if (!adjustments) {
            return null;
        }

        var it = adjustments.iterator();
        while (it.hasNext()) {
            var adjustment = it.next();
            if (adjustment.getPromotionID() === GAMEBALL_REDEMPTION_PROMOTION_ID) {
                return adjustment;
            }
        }
    } catch (e) {
        return null;
    }

    return null;
}

/**
 * Removes this module's PriceAdjustment from the basket, if present. Never
 * throws (H20-style - callers use this from inside their own failure paths
 * too).
 * @param {dw.order.Basket} basket
 * @returns {void}
 */
function removeAdjustment(basket) {
    try {
        var adjustment = findAdjustment(basket);
        if (adjustment) {
            basket.removePriceAdjustment(adjustment);
        }
    } catch (e) {
        Logger.error('redemptionStateStore~removeAdjustment failed: {0}', e && e.message);
    }
}

/**
 * Records a freshly-created hold on the basket: writes Basket.custom.gbHold*
 * and creates the order-level PriceAdjustment carrying the same values on
 * its own custom attributes. One Transaction.wrap (P1/P2), no HTTP inside it
 * (P3) - the caller has already made the one Gameball call this represents.
 *
 * Discount adjustments come back negative from getPrice() (see
 * orderPayload.js's own sumPriceAdjustments comment) - setPriceValue is
 * therefore called with a NEGATIVE amount to match that existing, already-
 * shipped convention.
 *
 * @param {dw.order.Basket} basket
 * @param {{holdReference: string, holdAmount: number, holdEquivalentPoints: number}} holdResult
 *   - exactly Gameball's own hold-create response body; every value here is
 *   Gameball's, never the shopper-requested figure the client asked for
 * @returns {void}
 */
function applyHold(basket, holdResult) {
    Transaction.wrap(function () {
        // Defensive: applyHold is only ever called once redemptionGate has
        // confirmed no hold is live, but guard here too (H22) rather than
        // trust caller discipline - a stray leftover adjustment from an
        // earlier bug must never be left orphaned alongside a new one.
        removeAdjustment(basket);

        var adjustment = basket.createPriceAdjustment(GAMEBALL_REDEMPTION_PROMOTION_ID);
        adjustment.setPriceValue(-holdResult.holdAmount);
        adjustment.custom.gbHoldReference = holdResult.holdReference;
        adjustment.custom.gbPointsRedeemed = holdResult.holdEquivalentPoints;

        basket.custom.gbHoldReference = holdResult.holdReference;
        basket.custom.gbHoldAmount = holdResult.holdAmount;
        basket.custom.gbHoldPointsRedeemed = holdResult.holdEquivalentPoints;
        basket.custom.gbHoldExpiresAt = new Date(Date.now() + assumedTtlMinutes() * 60000);
    });
}

/**
 * Clears every gbHold* attribute and removes the PriceAdjustment, regardless
 * of whether the caller already released the hold at Gameball - a discount
 * left live on the SFCC basket after the shopper (or the reconciliation
 * check) decided the hold is gone is a worse, immediately-visible bug than
 * an orphaned hold at Gameball, which Gameball's own timeout recovers.
 * @param {dw.order.Basket} basket
 * @param {string} reason - short machine-readable reason, logged only
 * @returns {void}
 */
function clearHold(basket, reason) {
    Transaction.wrap(function () {
        removeAdjustment(basket);

        basket.custom.gbHoldReference = null;
        basket.custom.gbHoldAmount = null;
        basket.custom.gbHoldPointsRedeemed = null;
        basket.custom.gbHoldExpiresAt = null;
    });

    Logger.info('redemptionStateStore~clearHold: cleared basket {0} ({1})', basket.getUUID(), reason || 'unspecified');
}

/**
 * Self-healing repair: recreates the PriceAdjustment from the basket's own
 * gbHold* attributes when it is missing or stale, without any Gameball call.
 * The basket's custom attributes - not the PriceAdjustment - are always
 * treated as the source of truth (see redemptionReconcile.js).
 * @param {dw.order.Basket} basket
 * @returns {void}
 */
function repairAdjustment(basket) {
    var holdAmount = Number(basket.custom.gbHoldAmount);
    if (!basket.custom.gbHoldReference || !isFinite(holdAmount) || holdAmount <= 0) {
        return;
    }

    var existing = findAdjustment(basket);
    var currentPrice = existing ? existing.getPrice().getValueOrNull() : null;

    if (existing && currentPrice !== null && Math.abs(currentPrice + holdAmount) < 0.0001) {
        // Already correct - nothing to do.
        return;
    }

    Transaction.wrap(function () {
        removeAdjustment(basket);

        var adjustment = basket.createPriceAdjustment(GAMEBALL_REDEMPTION_PROMOTION_ID);
        adjustment.setPriceValue(-holdAmount);
        adjustment.custom.gbHoldReference = basket.custom.gbHoldReference;
        adjustment.custom.gbPointsRedeemed = basket.custom.gbHoldPointsRedeemed;
    });
}

/**
 * @param {dw.order.Basket} basket
 * @returns {{holdReference: string, holdAmount: number, holdPointsRedeemed: number, holdExpiresAt: (Date|null)}|null}
 */
function readHold(basket) {
    if (!basket || !basket.custom.gbHoldReference) {
        return null;
    }

    return {
        holdReference: basket.custom.gbHoldReference,
        holdAmount: Number(basket.custom.gbHoldAmount) || 0,
        holdPointsRedeemed: Number(basket.custom.gbHoldPointsRedeemed) || 0,
        holdExpiresAt: basket.custom.gbHoldExpiresAt || null
    };
}

module.exports = {
    applyHold: applyHold,
    clearHold: clearHold,
    repairAdjustment: repairAdjustment,
    readHold: readHold,
    GAMEBALL_REDEMPTION_PROMOTION_ID: GAMEBALL_REDEMPTION_PROMOTION_ID
};
