'use strict';

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_customer_hooks');
var gameballService = require('*/cartridge/scripts/services/gameballService');
var gameballCredentials = require('*/cartridge/scripts/services/gameballCredentials');

/**
 * @returns {boolean} true if the integration is turned on and a Service
 * Credential has been configured in Business Manager
 */
function isGameballEnabled() {
    return !!Site.getCurrent().getCustomPreferenceValue('gameballEnabled') && gameballCredentials.isConfigured();
}

/**
 * Builds the upsert body for POST integrations/customers.
 * Gameball's v4.0 customers endpoint is a single idempotent upsert keyed on
 * customerId - there is no separate create/update shape.
 * @param {dw.customer.Profile} profile - The SFCC Customer Profile
 * @returns {Object} the request body expected by Gameball's customers endpoint
 */
function buildCustomerPayload(profile) {
    var displayName = ((profile.firstName || '') + ' ' + (profile.lastName || '')).trim();

    return {
        customerId: profile.customerNo,
        email: profile.email || undefined,
        customerAttributes: {
            displayName: displayName,
            firstName: profile.firstName || '',
            lastName: profile.lastName || '',
            email: profile.email || ''
        }
    };
}

/**
 * Upserts a customer to Gameball. Shared by both the registered and updated
 * hooks since Gameball's endpoint is idempotent on customerId.
 * @param {dw.customer.Customer} customer - The SFCC customer object
 * @param {string} hookName - name of the calling hook, for logging
 */
function upsertCustomer(customer, hookName) {
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
            body: buildCustomerPayload(profile)
        });

        if (!result.isOk()) {
            Logger.error('Gameball customer upsert failed ({0}): {1}', hookName, result.errorMessage);
        }
    } catch (e) {
        Logger.error('Exception in Gameball {0} hook: {1}', hookName, e.message);
    }
}

module.exports = {
    registered: function (customer) { upsertCustomer(customer, 'app.customer.registered'); },
    updated: function (customer) { upsertCustomer(customer, 'app.customer.updated'); }
};
