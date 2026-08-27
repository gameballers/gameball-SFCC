'use strict';

var Site = require('dw/system/Site');
var LineItemCtnr = require('dw/order/LineItemCtnr');
var PaymentInstrument = require('dw/order/PaymentInstrument');
var gameballMoney = require('*/cartridge/scripts/util/gameballMoney');
var lineItemPayload = require('*/cartridge/models/payload/lineItem');
var gameballIdentity = require('*/cartridge/models/identity/gameballIdentity');

// Not a standard dw.order.PaymentInstrument constant - this is the custom
// payment method id merchants configure for a "pay with Gameball points"
// tender, so it stays a plain string literal rather than an API constant.
var GAMEBALL_POINTS_PAYMENT_METHOD = 'GAMEBALL_POINTS';

/**
 * Sums a collection of dw.order.PriceAdjustment amounts (order-level here),
 * Money-guarded. Discount adjustments come back negative from getPrice() -
 * callers that want a positive "how much was discounted" figure should
 * Math.abs() the result themselves.
 * @param {dw.util.Collection} adjustments
 * @returns {number}
 */
function sumPriceAdjustments(adjustments) {
    var total = 0;
    if (!adjustments) {
        return total;
    }

    try {
        var it = adjustments.iterator();
        while (it.hasNext()) {
            total += gameballMoney.toNumber(it.next().getPrice());
        }
    } catch (e) {
        return total;
    }

    return total;
}

/**
 * Money-guarded read of a payment instrument's processed transaction amount.
 * @param {dw.order.PaymentInstrument} instrument
 * @returns {number}
 */
function getInstrumentAmount(instrument) {
    try {
        var transaction = instrument.getPaymentTransaction();
        return transaction ? gameballMoney.toNumber(transaction.getAmount()) : 0;
    } catch (e) {
        return 0;
    }
}

/**
 * totalPaid, per the Gameball money formula: order gross price, minus any
 * Gameball-points tender, minus (when the gameballExcludeGiftCertificateTender
 * preference is on, the default) gift-certificate tender, clamped to >= 0 and
 * rounded to the order currency's default fraction digits. Every Money read
 * goes through gameballMoney so a NOT_AVAILABLE amount never throws.
 * @param {dw.order.Order} order
 * @returns {number}
 */
function calculateTotalPaid(order) {
    var total = gameballMoney.toNumber(order.getTotalGrossPrice());
    var excludeGiftCertificates = !!Site.getCurrent().getCustomPreferenceValue('gameballExcludeGiftCertificateTender');

    try {
        var instruments = order.getPaymentInstruments();
        if (instruments) {
            var it = instruments.iterator();
            while (it.hasNext()) {
                var instrument = it.next();
                var method = instrument.getPaymentMethod();

                if (method === GAMEBALL_POINTS_PAYMENT_METHOD) {
                    total -= getInstrumentAmount(instrument);
                } else if (excludeGiftCertificates && method === PaymentInstrument.METHOD_GIFT_CERTIFICATE) {
                    total -= getInstrumentAmount(instrument);
                }
            }
        }
    } catch (e) {
        // fall back to whatever total was computed so far (gross price, minus
        // whatever tender deductions were already applied before the throw)
    }

    return gameballMoney.roundToCurrency(gameballMoney.clampNonNegative(total), order.getCurrencyCode());
}

/**
 * totalPrice: a defensible, pre-discount gross approximation - Gameball
 * documents this field as historical-only and not used in any point
 * calculation, so this intentionally does not attempt real tax-policy
 * branching (e.g. tax-inclusive vs exclusive pricing books).
 * @param {dw.order.Order} order
 * @returns {number}
 */
function calculateTotalPrice(order) {
    var merchandiseTotal = 0;

    try {
        var it = order.getAllProductLineItems().iterator();
        while (it.hasNext()) {
            var pli = it.next();
            try {
                if (!lineItemPayload.isOptionLineItem(pli)) {
                    merchandiseTotal += gameballMoney.toNumber(pli.getBasePrice()) * lineItemPayload.getQuantityValue(pli);
                }
            } catch (itemError) {
                // Skip just this line item's contribution - keep whatever was
                // already summed rather than discarding the whole total.
            }
        }
    } catch (e) {
        // getAllProductLineItems()/iterator() itself failed - fall back to
        // whatever was summed so far.
    }

    var shippingTotal = gameballMoney.toNumber(order.getShippingTotalPrice());
    var taxTotal = gameballMoney.toNumber(order.getTotalTax());

    return gameballMoney.roundToCurrency(merchandiseTotal + shippingTotal + taxTotal, order.getCurrencyCode());
}

/**
 * totalDiscount: absolute sum of ORDER-LEVEL price adjustments only (coupons,
 * promotions applied at the order level) - deliberately never derived as
 * totalPrice - totalPaid, which would incorrectly count payment-instrument
 * tender (e.g. gift certificates) as a discount.
 * @param {dw.order.Order} order
 * @returns {number}
 */
function calculateTotalDiscount(order) {
    var discount = 0;

    try {
        discount = Math.abs(sumPriceAdjustments(order.getPriceAdjustments()));
    } catch (e) {
        discount = 0;
    }

    return gameballMoney.roundToCurrency(gameballMoney.clampNonNegative(discount), order.getCurrencyCode());
}

/**
 * channel: best-effort mapping of order.getChannelType() (a constant on
 * dw.order.LineItemCtnr, not on Order) to Gameball's channel enum. The whole
 * lookup is wrapped in one broad try/catch and defaults to 'web' - this field
 * is low-stakes/informational and must never be the reason a whole order
 * fails to sync.
 * @param {dw.order.Order} order
 * @returns {string}
 */
function resolveChannel(order) {
    try {
        var channelType = order.getChannelType();

        switch (channelType) {
            case LineItemCtnr.CHANNEL_TYPE_CALLCENTER:
                return 'callcenter';
            case LineItemCtnr.CHANNEL_TYPE_STORE:
                return 'pos';
            case LineItemCtnr.CHANNEL_TYPE_STOREFRONT:
                return 'web';
            default:
                return 'web';
        }
    } catch (e) {
        return 'web';
    }
}

/**
 * Sanity-checks a phone number before sending it: non-empty and containing
 * at least one digit. Not full E.164 validation - just enough to avoid
 * forwarding an obviously empty/placeholder value, per "omit rather than
 * send a bad value".
 * @param {string} phone
 * @returns {boolean}
 */
function isPlausiblePhone(phone) {
    return !!phone && typeof phone === 'string' && /\d/.test(phone);
}

/**
 * Resolves the mobile number to report: billing address phone first, falling
 * back to the default shipment's shipping address phone. Returns null (never
 * an empty/malformed string) when neither is usable.
 * @param {dw.order.Order} order
 * @returns {string|null}
 */
function resolveMobile(order) {
    var phone = null;

    try {
        var billingAddress = order.getBillingAddress();
        phone = billingAddress && billingAddress.getPhone();
    } catch (e) {
        phone = null;
    }

    if (!isPlausiblePhone(phone)) {
        try {
            var shipment = order.getDefaultShipment();
            var shippingAddress = shipment && shipment.getShippingAddress();
            phone = shippingAddress && shippingAddress.getPhone();
        } catch (e) {
            phone = null;
        }
    }

    return isPlausiblePhone(phone) ? phone : null;
}

/**
 * Builds the `extra` object: string/number values ONLY (Gameball rejects
 * booleans/arrays/nested objects here) - isGiftOrder is therefore sent as
 * 1/0, never true/false.
 * @param {dw.order.Order} order
 * @returns {Object}
 */
function buildExtra(order) {
    var extra = {
        siteId: Site.getCurrent().getID(),
        locale: order.getCustomerLocaleID() || Site.getCurrent().getDefaultLocale(),
        currency: order.getCurrencyCode(),
        shipmentCount: 0,
        isGiftOrder: 0,
        sourceCode: order.getSourceCodeGroupID() || ''
    };

    try {
        var instruments = order.getPaymentInstruments();
        if (instruments && instruments.size() > 0) {
            var methods = [];
            var it = instruments.iterator();
            while (it.hasNext()) {
                methods.push(it.next().getPaymentMethod());
            }
            extra.paymentMethods = methods.join(',');
        }
    } catch (e) {
        // leave paymentMethods unset
    }

    try {
        extra.shipmentCount = order.getShipments().size();
    } catch (e) {
        extra.shipmentCount = 0;
    }

    try {
        var defaultShipment = order.getDefaultShipment();
        if (defaultShipment) {
            var shippingMethodID = defaultShipment.getShippingMethodID();
            if (shippingMethodID) {
                extra.shippingMethod = shippingMethodID;
            }
            extra.isGiftOrder = defaultShipment.isGift() ? 1 : 0;
        }
    } catch (e) {
        // leave shippingMethod unset / isGiftOrder at its 0 default
    }

    return extra;
}

/**
 * Resolves the redemption block: the Gameball hold reference this order
 * redeemed via item 08's Pay with Points, if any. Read primarily off the
 * order-level PriceAdjustment item 08's redemptionStateStore.js created on
 * the basket - SFCC copies Basket PriceAdjustments, including their custom
 * attributes, onto the Order automatically at order creation, so this is the
 * value item 08's own CheckoutServices-PlaceOrder append expects to find
 * here already. Falls back to Order.custom.gbHoldReference, which that same
 * append writes directly as a repair path if the automatic copy did not
 * happen.
 *
 * couponsLockReference/couponCodes are never populated here - they belong to
 * a separate, unbuilt Gameball-issued-coupon-code redemption feature
 * (build-plan section 8.4 "Model B") this cartridge has not built.
 *
 * Omits the whole redemption object rather than sending an empty one (H31)
 * when no hold reference is found - the overwhelming majority of orders,
 * which never touched item 08 at all.
 * @param {dw.order.Order} order
 * @returns {{pointsHoldReference: string}|null}
 */
function resolveRedemption(order) {
    var holdReference = '';

    try {
        var adjustments = order.getPriceAdjustments();
        if (adjustments) {
            var it = adjustments.iterator();
            while (it.hasNext() && !holdReference) {
                var adjustment = it.next();
                if (adjustment.custom && adjustment.custom.gbHoldReference) {
                    holdReference = adjustment.custom.gbHoldReference;
                }
            }
        }
    } catch (e) {
        holdReference = '';
    }

    if (!holdReference) {
        holdReference = order.custom.gbHoldReference || '';
    }

    return holdReference ? { pointsHoldReference: holdReference } : null;
}

/**
 * Builds the full request body for POST integrations/orders from a placed
 * SFCC order. Assumes the caller (gameballOrderApi.js) has already run
 * orderSyncGate - this module only builds the payload, it does not decide
 * whether the order should be tracked.
 * @param {dw.order.Order} order
 * @returns {Object}
 */
function build(order) {
    // orderSyncGate already guarantees a resolvable Gameball identity before
    // this is ever called (a registered customer, a guest matched to an
    // existing login, or a derived guest id), but guard here too rather
    // than rely on caller discipline (H22) - a future caller such as item
    // 06's retry-FAILED-orders job might invoke build() without re-running
    // the gate first.
    var identity = gameballIdentity.getOrderCustomerId(order);
    if (!identity.customerId) {
        throw new Error('Gameball order payload requires a resolvable customerId (' + (identity.reason || 'unknown') + ')');
    }

    var creationDate = order.getCreationDate();

    var payload = {
        customerId: identity.customerId,
        orderId: order.getOrderNo(),
        orderDate: creationDate ? creationDate.toISOString() : new Date().toISOString(),
        totalPaid: calculateTotalPaid(order),
        totalPrice: calculateTotalPrice(order),
        totalDiscount: calculateTotalDiscount(order),
        totalShipping: gameballMoney.toNumber(order.getShippingTotalPrice()),
        totalTax: gameballMoney.toNumber(order.getTotalTax()),
        channel: resolveChannel(order),
        // false on identity ladder rungs 1 (registered) and 2 (guest matched
        // to an existing login), true only on rung 3 (true guest). Sent
        // explicitly on every order, including registered ones. Replaces the
        // previous hard-coded false, which assumed every order reaching this
        // builder already had a registered profile.
        guest: identity.guest,
        cartId: order.getUUID(),
        merchant: {
            uniqueId: Site.getCurrent().getID(),
            name: Site.getCurrent().getName()
        },
        extra: buildExtra(order)
    };

    var email = order.getCustomerEmail();
    if (email) {
        payload.email = email;
    }

    var mobile = resolveMobile(order);
    if (mobile) {
        payload.mobile = mobile;
    }

    var lineItems = lineItemPayload.build(order);
    if (lineItems && lineItems.length) {
        payload.lineItems = lineItems;
    }

    var redemption = resolveRedemption(order);
    if (redemption) {
        payload.redemption = redemption;
    }

    return payload;
}

module.exports = {
    build: build
};
