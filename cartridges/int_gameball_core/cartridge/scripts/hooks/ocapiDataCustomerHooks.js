'use strict';

var runner = require('*/cartridge/scripts/hooks/ocapiCustomerHookRunner');

// This module is separate from ocapiShopCustomerHooks.js for one mechanical
// reason: SFCC resolves a hook to the module function named by the LAST SEGMENT
// of the hook id, so dw.ocapi.shop.customer.afterPOST and
// dw.ocapi.data.customer_list.customers.afterPOST would both resolve to a
// single exported afterPOST if they shared a module, and one namespace would
// silently receive the other's arguments and the other's source label. The
// build plan's own snippet points all six customer hooks at one module and
// cannot work for that reason.
//
// The last-segment resolution rule is itself UNVERIFIED against current SFCC
// documentation - but the split is correct under EITHER resolution rule,
// whereas the single-module form is correct under only one. That asymmetry,
// not certainty about the rule, is why it is split.
//
// The namespaces are also split by method and the split is not symmetric:
// creation lives on the PLURAL customers (afterPOST, afterPUT), editing on
// the SINGULAR customer (afterPATCH, and beforeDELETE, which the GDPR
// erasure item adds here). Getting either wrong yields a hook that never fires,
// with no diagnostic anywhere.

/**
 * dw.ocapi.data.customer_list.customers.afterPOST - a CRM, OMS or middleware
 * created a customer through the Data API. PLURAL namespace.
 *
 * Gated OFF by default (gameballSyncDataApiCustomers): this hook runs inside
 * the platform's own database transaction, so a bulk upsert would hold one
 * transaction open per record for the duration of a synchronous Gameball call.
 * The delta sweep covers these customers within one schedule interval instead,
 * with no request-path risk at all.
 *
 * Takes no named parameters: the Data-API hook signatures are UNVERIFIED and
 * may lead with a dw.customer.CustomerList, so arguments is forwarded whole
 * and the runner scans it for the Profile.
 *
 * @returns {dw.system.Status} always Status.OK
 */
function afterPOST() {
    return runner.run('dw.ocapi.data.customer_list.customers.afterPOST', 'OCAPI_DATA_POST', arguments);
}

/**
 * dw.ocapi.data.customer_list.customers.afterPUT - a customer replaced by
 * login. PLURAL namespace.
 *
 * This is the shape a CRM or OMS bulk-upsert-by-login takes and is therefore
 * the single most likely Data-API hook to fire at a real merchant, which is why
 * it is registered even though the plan's hook list does not lead with it.
 *
 * @returns {dw.system.Status} always Status.OK
 */
function afterPUT() {
    return runner.run('dw.ocapi.data.customer_list.customers.afterPUT', 'OCAPI_DATA_PUT', arguments);
}

/**
 * dw.ocapi.data.customer_list.customer.afterPATCH - a customer edited through
 * the Data API. SINGULAR namespace: the plural one carries only POST and PUT.
 *
 * @returns {dw.system.Status} always Status.OK
 */
function afterPATCH() {
    return runner.run('dw.ocapi.data.customer_list.customer.afterPATCH', 'OCAPI_DATA_PATCH', arguments);
}

module.exports = {
    afterPOST: afterPOST,
    afterPUT: afterPUT,
    afterPATCH: afterPATCH
};
