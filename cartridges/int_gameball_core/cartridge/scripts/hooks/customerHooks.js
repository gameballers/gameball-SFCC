'use strict';

var gameballCustomerApi = require('../api/gameballCustomerApi');

module.exports = {
    registered: function (customer) { gameballCustomerApi.sendCustomer(customer, 'app.customer.registered'); },
    updated: function (customer) { gameballCustomerApi.sendCustomer(customer, 'app.customer.updated'); }
};
