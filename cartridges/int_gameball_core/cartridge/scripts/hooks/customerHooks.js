'use strict';

var gameballCustomerApi = require('*/cartridge/scripts/api/gameballCustomerApi');

module.exports = {
    registered: function (customer) { gameballCustomerApi.sendCustomer(customer, 'app.customer.registered'); },
    updated: function (customer) { gameballCustomerApi.sendCustomer(customer, 'app.customer.updated'); }
};
