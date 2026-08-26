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

    var payload = {
        customerId: profile.customerNo,
        email: profile.email || undefined,
        customerAttributes: {
            displayName: displayName,
            firstName: profile.firstName || '',
            lastName: profile.lastName || '',
            email: profile.email || ''
        }
    };

    var phone = profile.phoneMobile || profile.phoneHome || profile.phoneBusiness;
    if (phone) {
        payload.mobile = phone;
    }

    if (profile.birthday) {
        // SFCC birthday is a Date object. Convert to YYYY-MM-DD.
        var StringUtils = require('dw/util/StringUtils');
        var Calendar = require('dw/util/Calendar');
        var cal = new Calendar(profile.birthday);
        payload.customerAttributes.dateOfBirth = StringUtils.formatCalendar(cal, 'yyyy-MM-dd');
    }

    return payload;
}

module.exports = {
    build: build
};
