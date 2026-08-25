'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_customer_hooks');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');
var customerPayload = require('*/cartridge/models/payload/customerPayload');

/**
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * Upserts a customer to Gameball. Shared by both the registered and updated
 * hooks since Gameball's endpoint is idempotent on customerId.
 * @param {dw.customer.Customer} customer - The SFCC customer object
 * @param {string} hookName - name of the calling hook, for logging
 */
function sendCustomer(customer, hookName) {
    try {
        if (!isGameballEnabled()) {
            return;
        }

        var profile = customer && customer.profile;
        if (!profile) {
            return;
        }

        var result = gameballService.call({
            path: 'integrations/customers',
            method: 'POST',
            body: customerPayload.build(profile)
        });

        if (!result.isOk()) {
            Logger.error('Gameball customer upsert failed ({0}): {1}', hookName, result.errorMessage);
        }
    } catch (e) {
        Logger.error('Exception in Gameball {0} hook: {1}', hookName, e.message);
    }
}

module.exports = {
    sendCustomer: sendCustomer
};
