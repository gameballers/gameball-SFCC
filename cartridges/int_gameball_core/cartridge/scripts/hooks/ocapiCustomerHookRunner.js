'use strict';

var Status = require('dw/system/Status');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.customer');
var gameballCustomerApi = require('*/cartridge/scripts/api/gameballCustomerApi');

/**
 * Finds the dw.customer.Profile among a hook's arguments.
 *
 * Scans the argument list rather than binding positionally, and that choice is
 * the whole reason this module exists. The Shop-API signatures are documented
 * as afterPOST(customer, customerRegistration) and afterPATCH(customer,
 * customerInput), but the Data-API customer hook signatures are UNVERIFIED -
 * the build plan states only beforeDELETE(customer, customerListId) for the
 * singular namespace and says nothing about the arity or argument order of
 * customers.afterPOST, customers.afterPUT or customer.afterPATCH, any of which
 * may lead with a dw.customer.CustomerList. A positional guess that is wrong
 * produces a hook that silently never syncs anything - which is the exact
 * failure mode this whole item exists to eliminate, and one with no symptom
 * anywhere. The scan is correct under every plausible arity, at the cost of
 * inspecting at most a handful of arguments.
 *
 * Duck-typed rather than instanceof-checked: a dw.customer.Customer is
 * identified by having getProfile, a dw.customer.Profile by having
 * getCustomerNo. Neither test can be satisfied by a CustomerList or a
 * document/DTO argument, and instanceof against a platform class is not
 * reliable across the OCAPI boundary.
 *
 * Exported because the GDPR erasure item's beforeDELETE adapter needs exactly
 * this resolution and must not grow a second copy of it.
 *
 * @param {Object} args - the hook function's own arguments object
 * @returns {dw.customer.Profile|null} the first argument that resolves to a
 *          Profile, or null
 */
function resolveProfile(args) {
    if (!args) {
        return null;
    }

    for (var i = 0; i < args.length; i++) {
        // Per-argument guard (H19): one argument whose getter throws must not
        // stop the scan reaching the argument that would have worked.
        try {
            var arg = args[i];
            if (arg) {
                if (typeof arg.getProfile === 'function') {
                    var profile = arg.getProfile();
                    if (profile) {
                        return profile;
                    }
                } else if (typeof arg.getCustomerNo === 'function') {
                    return arg;
                }
            }
        } catch (e) {
            // Not a customer-shaped argument, or a getter that threw on a
            // half-constructed object inside the platform's own transaction.
            // Keep scanning: the next argument may still be the Profile.
        }
    }

    return null;
}

/**
 * Runs one OCAPI/SCAPI customer hook.
 *
 * Never throws, and that is load-bearing rather than defensive style. For
 * state-changing OCAPI methods the before/after hooks and the platform's own
 * system logic run inside ONE database transaction (build-plan section 5.1
 * caveat ii), so an uncaught throw here would roll back the customer creation
 * or update that triggered it - turning a Gameball outage into a merchant's
 * CRM failing to write customers. Note that returning Status.OK does NOT
 * protect against that; only the try/catch does. The return value is there
 * because the platform expects one.
 *
 * @param {string} hookName - the fully qualified hook id, for logging
 * @param {string} source - see customerSyncGate.evaluate
 * @param {Object} args - the hook function's own arguments object
 * @returns {dw.system.Status} always Status.OK
 */
function run(hookName, source, args) {
    try {
        var profile = resolveProfile(args);
        if (!profile) {
            // Ungated by gameballInfoLogEnabled: this only ever fires on an
            // anomaly, and it is the single symptom that would distinguish "the
            // hook fired but we could not find the customer" from "the hook
            // never fired at all" - which is the failure this item's whole
            // sandbox spike is designed to detect.
            Logger.error('Gameball OCAPI hook {0} could not resolve a customer profile from {1} argument(s)',
                hookName, args && args.length ? args.length : 0);
            return new Status(Status.OK);
        }

        gameballCustomerApi.sendProfile(profile, source);
    } catch (e) {
        Logger.error('Gameball OCAPI hook {0} failed: {1}', hookName, e && e.message);
    }

    return new Status(Status.OK);
}

module.exports = {
    run: run,
    resolveProfile: resolveProfile
};
