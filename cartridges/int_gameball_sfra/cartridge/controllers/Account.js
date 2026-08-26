'use strict';

var server = require('server');
server.extend(module.superModule);

var CustomerMgr = require('dw/customer/CustomerMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball.customer');

// NOTE: gameballCustomerApi is deliberately NOT required here. It is a late
// require inside each listener - the comment at the SubmitRegistration append
// gives the reason, and Gameball.js makes the same call for the same reason.

// The SFCC trigger that produced a sync, logged by gameballCustomerApi and
// (from the OCAPI item onwards) persisted on the profile, so the vocabulary is
// UPPER_SNAKE state-machine style rather than the route id it names.
var SOURCE_SUBMIT_REGISTRATION = 'ACCOUNT_SUBMIT_REGISTRATION';
var SOURCE_SAVE_PROFILE = 'ACCOUNT_SAVE_PROFILE';

/**
 * Null/exception-safe read of a candidate customer's persistent customerNo.
 *
 * Both resolvers below accept a candidate only when this is truthy, rather
 * than settling for a truthy .profile. viewData.authenticatedCustomer is not
 * guaranteed to be a dw.customer.Customer on every SFRA version - it may be an
 * SFRA account model, or absent entirely - so the read itself is guarded
 * rather than the type assumed. An SFRA model's .profile is a plain object
 * carrying firstName / lastName / email and no customerNo, and a .profile test
 * alone would accept it: customerPayload.build would then produce a payload
 * with no customerId, every registration on such an instance would log
 * reason=no_customer_id and never sync, and the CustomerMgr fallback that
 * exists to defend against exactly that would sit one line below, unreached.
 * Asserting the one field the upsert cannot be built without is what makes
 * that fallback real rather than decorative.
 *
 * @param {dw.customer.Customer} customer
 * @returns {string} '' when the customer, its profile or the number is absent
 */
function readCustomerNo(customer) {
    try {
        return (customer && customer.profile && customer.profile.customerNo) || '';
    } catch (e) {
        return '';
    }
}

/**
 * Null/exception-safe customer lookup by login.
 * @param {string} login - in base SFRA the registration login is the email
 * @returns {dw.customer.Customer|null}
 */
function getCustomerByLogin(login) {
    try {
        return CustomerMgr.getCustomerByLogin(login) || null;
    } catch (e) {
        return null;
    }
}

/**
 * Null/exception-safe customer lookup by customer number.
 * @param {string} customerNo
 * @returns {dw.customer.Customer|null}
 */
function getCustomerByCustomerNumber(customerNo) {
    try {
        return CustomerMgr.getCustomerByCustomerNumber(customerNo) || null;
    } catch (e) {
        return null;
    }
}

/**
 * Resolves the dw.customer.Customer that Account-SubmitRegistration just
 * created, from the base route's view data.
 *
 * The previous implementation fell back to req.currentCustomer.raw, which is
 * the customer resolved at the START of the request - i.e. the ANONYMOUS
 * customer, whose .profile is null. That fallback therefore never produced a
 * usable customer; all it did was convert "we could not find the profile" into
 * a silent no-op inside sendCustomer, so a registration that failed to sync
 * left no trace anywhere. CustomerMgr.getCustomerByLogin(email) replaces it:
 * base SFRA registers with login === email, and it is the same fallback the
 * Yotpo cartridge ships on this route.
 *
 * @param {Object} viewData - res.getViewData() of the base route
 * @returns {dw.customer.Customer|null}
 */
function resolveRegisteredCustomer(viewData) {
    if (!viewData) {
        return null;
    }

    if (readCustomerNo(viewData.authenticatedCustomer)) {
        return viewData.authenticatedCustomer;
    }

    if (viewData.email) {
        return getCustomerByLogin(viewData.email);
    }

    return null;
}

/**
 * Resolves the dw.customer.Customer whose profile Account-SaveProfile just
 * updated.
 *
 * req.currentCustomer.raw is the LIVE dw.customer.Customer, so .profile.email
 * already reflects the address the shopper just saved - which matters because
 * the top-level email is Gameball's channel-merging key. req.currentCustomer
 * .profile is the SFRA plain model and is a request-start snapshot, so only
 * its immutable customerNo is used, and only as a fallback.
 *
 * UNVERIFIED (no sandbox in this environment): that "live" claim. Base SFRA's
 * SaveProfile does not mutate req.currentCustomer.raw - it re-fetches with
 * CustomerMgr.getCustomerByCustomerNumber and writes to that object inside its
 * own Transaction - so this rests on SFCC handing back the same persistent
 * instance for both handles within one request. Very likely, never checked
 * here, and the only assumption in this item whose failure mode is silent
 * WRONG DATA rather than a missing log line: a shopper who changes their
 * address would have the OLD one POSTed as the merging key while the INFO line
 * still reads "upsert sent". Cheapest spike: save a profile with a changed
 * email on a sandbox and compare raw.profile.email against what base
 * committed. If it is stale, the fix is to swap the two rungs below - the
 * lookup helper is already there - at the cost of one extra lookup per save.
 *
 * @param {Object} req - the SFRA request
 * @returns {dw.customer.Customer|null}
 */
function resolveSavedCustomer(req) {
    var currentCustomer = req && req.currentCustomer;
    if (!currentCustomer) {
        return null;
    }

    if (readCustomerNo(currentCustomer.raw)) {
        return currentCustomer.raw;
    }

    var customerNo = currentCustomer.profile && currentCustomer.profile.customerNo;
    if (customerNo) {
        return getCustomerByCustomerNumber(customerNo);
    }

    return null;
}

/**
 * Upserts the newly-registered customer to Gameball.
 *
 * The dispatch used to run through a private extension point in the
 * SFRA-reserved app.* namespace, one this cartridge both registered and fired
 * itself. That sent exactly one upsert - registering an extension point makes
 * it resolvable, and a manual dispatch is what actually fires it - but any
 * other cartridge on the path, or a future SFRA release, firing that same name
 * would have silently added a second POST to every registration, with nothing
 * in the code or the log to reveal it. Calling the API module directly yields
 * exactly one upsert whether or not base SFRA fires the name, which is why it
 * was preferred over merely de-registering the extension point and leaving the
 * indirection in place.
 *
 * The mechanical invariant this buys, and the one to re-check on any future
 * edit: nothing under cartridges/ dispatches a Gameball customer sync through
 * a hook any more, so there is exactly one call site per route.
 *
 * The work sits in route:BeforeComplete (not route:Complete) because the base
 * route's own listener is registered first and therefore runs first, so the
 * customer exists and is logged in by the time this runs; because an exception
 * in a route:Complete listener lands after the response is committed; and
 * because it is what the build plan mandates for every controller extension.
 *
 * The cost, stated plainly and precisely, because it is the thing a future
 * maintainer will weigh: the response is no longer emitted before the POST.
 * At route:Complete the JSON had already been written; at route:BeforeComplete
 * the shopper's browser waits for the whole synchronous Gameball call, which
 * against an unreachable or hanging Gameball means waiting out the service
 * timeout - 15000 ms in metadata/site_template/services.xml, with no circuit
 * breaker or rate-limit settings shipped on the service to cut it short. The
 * queue that would take the call off the request path entirely is out of scope
 * by decision, so this is accepted, not solved.
 */
server.append('SubmitRegistration', function (req, res, next) {
    this.on('route:BeforeComplete', function (req, res) {
        try {
            var viewData = res.getViewData();

            // A failed registration is a normal outcome and base has already
            // told the shopper - nothing to log.
            if (!viewData || !viewData.success) {
                return;
            }

            var customer = resolveRegisteredCustomer(viewData);
            if (!customer) {
                // Worth a line: the registration succeeded but we could not
                // find the profile it created, which is the one case the old
                // anonymous-customer fallback used to hide completely.
                // Ungated, unlike the API module's warns - the info-gate
                // helper is private to gameballCustomerApi by design (no
                // shared logger module ships in this iteration) and this line
                // only ever fires on an anomaly, so the volume is nil.
                // 'present'/'absent', never the address itself: an email is on
                // the build plan's REDACT list and a log line is not exempt.
                Logger.warn('Account~SubmitRegistration could not resolve the registered customer, Gameball sync skipped (email={0})',
                    viewData && viewData.email ? 'present' : 'absent');
                return;
            }

            // Late require, against H2, for the reason Gameball.js states for
            // the identical hazard: gameballCustomerApi pulls in
            // gameballCredentials and gameballService, both of which call
            // LocalServiceRegistry.createService at MODULE load. On an instance
            // where services.xml has not been imported yet, or where the
            // gameball.http.api service was deleted in BM, a module-load throw
            // would happen before this try block exists - and at the top of the
            // file it would take the whole controller module with it, so every
            // Account-* route 500s. That includes Account-Header, which base
            // SFRA's header component remote-includes on every storefront page
            // (UNVERIFIED here - app_storefront_base is not vendored on this
            // machine - but the controller-wide failure holds either way), so a
            // Gameball service-config mistake could replace the account header
            // site-wide with an error fragment. Required here instead, service
            // construction sits inside the boundary catch and a broken service
            // costs one logged line rather than the account pages.
            var gameballCustomerApi = require('*/cartridge/scripts/api/gameballCustomerApi');

            // Return value ignored: every outcome, including every failure, is
            // already logged inside sendCustomer, and there is nothing this
            // controller could usefully do differently with it.
            gameballCustomerApi.sendCustomer(customer, SOURCE_SUBMIT_REGISTRATION);
        } catch (e) {
            Logger.error('Account~SubmitRegistration Gameball customer sync did not run: {0}', e && e.message);
        }
    });

    next();
});

/**
 * Upserts the just-saved profile to Gameball. Same dispatch change and same
 * route:BeforeComplete reasoning as SubmitRegistration above.
 */
server.append('SaveProfile', function (req, res, next) {
    this.on('route:BeforeComplete', function (req, res) {
        try {
            var viewData = res.getViewData();

            // Failed validation or a wrong password is a normal outcome.
            if (!viewData || !viewData.success) {
                return;
            }

            // The route already carries base's userLoggedIn.validateLoggedIn
            // middleware. Re-guarded here anyway rather than relying on caller
            // discipline: a future SFRA release could change which middleware
            // that route is composed from, and this listener would never know.
            if (!req.currentCustomer || !req.currentCustomer.raw || !req.currentCustomer.raw.authenticated) {
                return;
            }

            var customer = resolveSavedCustomer(req);
            if (!customer) {
                Logger.warn('Account~SaveProfile could not resolve the current customer, Gameball sync skipped');
                return;
            }

            // Late require for the reason given at SubmitRegistration above:
            // a module-load service construction must not be able to break
            // every Account route.
            var gameballCustomerApi = require('*/cartridge/scripts/api/gameballCustomerApi');

            gameballCustomerApi.sendCustomer(customer, SOURCE_SAVE_PROFILE);
        } catch (e) {
            Logger.error('Account~SaveProfile Gameball customer sync did not run: {0}', e && e.message);
        }
    });

    next();
});

module.exports = server.exports();
