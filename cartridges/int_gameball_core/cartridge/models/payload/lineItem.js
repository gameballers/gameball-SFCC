'use strict';

var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_order_hooks');
var gameballMoney = require('*/cartridge/scripts/util/gameballMoney');

/**
 * True when the given product line item exists solely to represent a
 * selected product option (e.g. an option value on a configurable product)
 * rather than a purchasable line in its own right - these are excluded from
 * the Gameball lineItems[] array. Guarded because isOptionProductLineItem
 * isn't guaranteed to exist on every line item type returned by
 * getAllProductLineItems().
 * @param {dw.order.ProductLineItem} pli
 * @returns {boolean}
 */
function isOptionLineItem(pli) {
    try {
        return typeof pli.isOptionProductLineItem === 'function' && pli.isOptionProductLineItem();
    } catch (e) {
        return false;
    }
}

/**
 * Null/exception-safe quantity read, defaulting to 0.
 * @param {dw.order.ProductLineItem} pli
 * @returns {number}
 */
function getQuantityValue(pli) {
    try {
        return pli.getQuantityValue() || 0;
    } catch (e) {
        return 0;
    }
}

/**
 * Walks a product's primary category up to the catalog root, collecting
 * category IDs along the way (leaf first). Guarded end-to-end - a product
 * with no primary category, or a category tree that fails to resolve,
 * simply yields no category chain rather than throwing.
 * @param {dw.catalog.Product} product
 * @returns {string[]|null}
 */
function buildCategoryChain(product) {
    try {
        var category = product.getPrimaryCategory();
        if (!category) {
            return null;
        }

        var chain = [];
        var current = category;
        while (current) {
            chain.push(current.getID());
            current = current.getParent();
        }

        return chain.length ? chain : null;
    } catch (e) {
        return null;
    }
}

/**
 * Best-effort currency code for a product line item, read off the order/
 * basket that contains it. Guarded because getLineItemCtnr()/
 * getCurrencyCode() aren't guaranteed to resolve for every line item;
 * gameballMoney.roundToCurrency() falls back to 2 fraction digits when this
 * returns null.
 * @param {dw.order.ProductLineItem} pli
 * @returns {string|null}
 */
function getLineItemCurrencyCode(pli) {
    try {
        var ctnr = pli.getLineItemCtnr();
        return ctnr ? ctnr.getCurrencyCode() : null;
    } catch (e) {
        return null;
    }
}

/**
 * Sum of a product line item's OWN price adjustments (not order-level ones),
 * Money-guarded. Discount adjustments come back negative from getPrice().
 * @param {dw.order.ProductLineItem} pli
 * @returns {number}
 */
function sumOwnPriceAdjustments(pli) {
    var total = 0;

    try {
        var adjustments = pli.getPriceAdjustments();
        if (!adjustments) {
            return total;
        }

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
 * Builds the `extra` object for one line item: the SFCC line item UUID, plus
 * the master product ID when the ordered product is a variant.
 * @param {dw.order.ProductLineItem} pli
 * @param {dw.catalog.Product} product - already-resolved product, may be null
 * @returns {Object}
 */
function buildLineItemExtra(pli, product) {
    var extra = {};

    try {
        extra.sfccUUID = pli.getUUID();
    } catch (e) {
        // no UUID available - leave unset
    }

    try {
        if (product && typeof product.isVariant === 'function' && product.isVariant()) {
            var master = product.getMasterProduct();
            if (master) {
                extra.masterId = master.getID();
            }
        }
    } catch (e) {
        // not a variant, or master product didn't resolve - omit
    }

    return extra;
}

/**
 * Builds one Gameball lineItems[] entry from a single (non-option) product
 * line item.
 * @param {dw.order.ProductLineItem} pli
 * @returns {Object}
 */
function buildLineItem(pli) {
    var quantity = getQuantityValue(pli);

    // pli.getProduct() can return null for a line item whose product was
    // deleted from the catalog after the order was placed - every read of
    // `product` below is guarded for that.
    var product = null;
    try {
        product = pli.getProduct();
    } catch (e) {
        product = null;
    }

    var sku = pli.getProductID();
    try {
        if (product && product.getManufacturerSKU()) {
            sku = product.getManufacturerSKU();
        }
    } catch (e) {
        sku = pli.getProductID();
    }

    var item = {
        productId: pli.getProductID(),
        quantity: quantity,
        price: gameballMoney.toNumber(pli.getBasePrice()),
        sku: sku,
        title: pli.getProductName()
    };

    if (product) {
        var categoryChain = buildCategoryChain(product);
        if (categoryChain) {
            item.category = categoryChain;
        }

        try {
            var vendor = product.getBrand();
            if (vendor) {
                item.vendor = vendor;
            }
        } catch (e) {
            // no brand available - omit
        }
    }

    var currencyCode = getLineItemCurrencyCode(pli);

    var taxTotal = gameballMoney.toNumber(pli.getTax());
    item.taxes = quantity > 0 ? gameballMoney.roundToCurrency(taxTotal / quantity, currencyCode) : 0;

    var discountTotal = Math.abs(sumOwnPriceAdjustments(pli));
    item.discount = quantity > 0 ? gameballMoney.roundToCurrency(discountTotal / quantity, currencyCode) : 0;

    var extra = buildLineItemExtra(pli, product);
    if (Object.keys(extra).length) {
        item.extra = extra;
    }

    return item;
}

/**
 * Builds the lineItems[] array for the Gameball order payload from every
 * non-option product line item on the order. Always returns an array (empty
 * when there is nothing to send) - the caller decides whether to omit the
 * `lineItems` key entirely.
 * @param {dw.order.Order} order
 * @returns {Object[]}
 */
function build(order) {
    var items = [];

    try {
        var it = order.getAllProductLineItems().iterator();
        while (it.hasNext()) {
            var pli = it.next();
            if (isOptionLineItem(pli)) {
                continue;
            }

            try {
                items.push(buildLineItem(pli));
            } catch (itemError) {
                // Skip just this one line item rather than aborting the whole
                // build - without this, one bad item would silently truncate
                // every item after it in the iteration.
                Logger.error('Gameball line item skipped due to a build error: {0}', itemError && itemError.message);
            }
        }
    } catch (e) {
        return items;
    }

    return items;
}

module.exports = {
    build: build,
    isOptionLineItem: isOptionLineItem,
    getQuantityValue: getQuantityValue
};
