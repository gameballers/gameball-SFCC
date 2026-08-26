'use strict';

var server = require('server');
var base = module.superModule;
server.extend(base);

var HookMgr = require('dw/system/HookMgr');

/**
 * Append to SubmitRegistration to fire our Gameball customer.registered hook.
 */
server.append('SubmitRegistration', function (req, res, next) {
    this.on('route:Complete', function (req, res) {
        var viewData = res.getViewData();
        // If registration was successful
        if (viewData && viewData.success) {
            // In SFRA, SubmitRegistration logs the customer in and sets authenticatedCustomer in viewData
            var customer = viewData.authenticatedCustomer;
            
            // Fallback to req.currentCustomer.raw if viewData doesn't have it
            if (!customer && req.currentCustomer && req.currentCustomer.raw) {
                customer = req.currentCustomer.raw;
            }

            if (customer && HookMgr.hasHook('app.customer.registered')) {
                HookMgr.callHook('app.customer.registered', 'registered', customer);
            }
        }
    });
    next();
});

/**
 * Append to SaveProfile to fire our Gameball customer.updated hook.
 */
server.append('SaveProfile', function (req, res, next) {
    this.on('route:Complete', function (req, res) {
        var viewData = res.getViewData();
        if (viewData && viewData.success) {
            if (req.currentCustomer && req.currentCustomer.raw && req.currentCustomer.raw.authenticated) {
                if (HookMgr.hasHook('app.customer.updated')) {
                    HookMgr.callHook('app.customer.updated', 'updated', req.currentCustomer.raw);
                }
            }
        }
    });
    next();
});

module.exports = server.exports();
