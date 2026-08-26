'use strict';

var runner = require('*/cartridge/scripts/hooks/ocapiCustomerHookRunner');

/**
 * dw.ocapi.shop.customer.afterPOST - a customer registered through the
 * OCAPI/SCAPI Shop API, i.e. a headless storefront registration. Semantically
 * identical to Account-SubmitRegistration and gated to behave identically.
 *
 * The namespace is SINGULAR customer. There is no dw.ocapi.shop.customers.*
 * namespace, and a wrong hook name fails silently forever - nothing in the
 * platform reports an unresolved hook id.
 *
 * Documented signature is (customer, customerRegistration), but arguments is
 * forwarded whole rather than the named parameters: the runner scans for the
 * Profile, so the adapter does not have to be right about argument order.
 *
 * @param {dw.customer.Customer} customer
 * @param {Object} customerRegistration - the OCAPI document
 * @returns {dw.system.Status} always Status.OK
 */
function afterPOST(customer, customerRegistration) { // eslint-disable-line no-unused-vars
    return runner.run('dw.ocapi.shop.customer.afterPOST', 'OCAPI_SHOP_POST', arguments);
}

/**
 * dw.ocapi.shop.customer.afterPATCH - a headless storefront edited a customer.
 * SINGULAR namespace, as above.
 *
 * @param {dw.customer.Customer} customer
 * @param {Object} customerInput - the OCAPI document
 * @returns {dw.system.Status} always Status.OK
 */
function afterPATCH(customer, customerInput) { // eslint-disable-line no-unused-vars
    return runner.run('dw.ocapi.shop.customer.afterPATCH', 'OCAPI_SHOP_PATCH', arguments);
}

module.exports = {
    afterPOST: afterPOST,
    afterPATCH: afterPATCH
};
