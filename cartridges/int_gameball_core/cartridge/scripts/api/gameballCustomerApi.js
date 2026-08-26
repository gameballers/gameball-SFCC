'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_customer_hooks');
var gameballCredentials = require('../services/gameballCredentials');
var customerPayload = require('../../models/payload/customerPayload');
var gameballService = require('../services/gameballService');


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

        var payload = customerPayload.build(profile);
        var result = gameballService.call({
            path: 'integrations/customers',
            body: payload
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
