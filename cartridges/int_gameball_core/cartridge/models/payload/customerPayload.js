'use strict';

/**
 * Builds the upsert body for POST integrations/customers.
 * Gameball's v4.0 customers endpoint is a single idempotent upsert keyed on
 * customerId - there is no separate create/update shape.
 * @param {dw.customer.Profile} profile - The SFCC Customer Profile
 * @returns {Object} the request body expected by Gameball's customers endpoint
 */
function build(profile) {
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

module.exports = {
    build: build
};
