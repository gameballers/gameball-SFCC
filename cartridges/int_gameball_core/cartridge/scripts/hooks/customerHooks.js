'use strict';

var gameballService = require('*/cartridge/scripts/services/gameballService');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_customer_hooks');

/**
 * Maps a SFCC Profile to the Gameball Expected JSON Payload (matching Salesforce Contacts)
 * @param {dw.customer.Profile} profile - The SFCC Customer Profile
 * @returns {Array} - The JSON Array payload expected by Gameball Middleware
 */
function createPayload(profile) {
    if (!profile) return null;

    return [{
        Id: profile.customerNo,
        FirstName: profile.firstName || '',
        LastName: profile.lastName || '',
        Email: profile.email || ''
    }];
}

/**
 * Hook executed when a customer successfully registers a new account
 * @param {dw.customer.Customer} customer - The registered customer object
 */
function onCustomerRegistered(customer) {
    try {
        var profile = customer.profile;
        if (!profile) {
            return;
        }

        var payload = createPayload(profile);
        
        var result = gameballService.call({
            path: 'salesforce/customers/create',
            method: 'POST',
            body: payload
        });

        if (!result.isOk()) {
            Logger.error('Gameball Customer Create Failed: {0}', result.errorMessage);
        }
    } catch (e) {
        Logger.error('Exception in Gameball app.customer.registered hook: {0}', e.message);
    }
}

/**
 * Hook executed when a customer updates their profile
 * @param {dw.customer.Customer} customer - The updated customer object
 */
function onCustomerUpdated(customer) {
    try {
        var profile = customer.profile;
        if (!profile) {
            return;
        }

        var payload = createPayload(profile);
        
        var result = gameballService.call({
            path: 'salesforce/customers/update',
            method: 'POST',
            body: payload
        });

        if (!result.isOk()) {
            Logger.error('Gameball Customer Update Failed: {0}', result.errorMessage);
        }
    } catch (e) {
        Logger.error('Exception in Gameball app.customer.updated hook: {0}', e.message);
    }
}

module.exports = {
    registered: onCustomerRegistered,
    updated: onCustomerUpdated
};
