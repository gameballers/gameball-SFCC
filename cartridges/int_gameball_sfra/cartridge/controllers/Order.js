'use strict';

var server = require('server');
server.extend(module.superModule);

var CustomerMgr = require('dw/customer/CustomerMgr');
var OrderMgr = require('dw/order/OrderMgr');
var Logger = require('dw/system/Logger').getLogger('Gameball', 'gameball_order_confirm');
var gameballOrderApi = require('*/cartridge/scripts/api/gameballOrderApi');
var gameballCustomerApi = require('*/cartridge/scripts/api/gameballCustomerApi');

// A SECOND logger, deliberately. This controller now serves two Gameball
// domains - order tracking on Confirm, customer sync on CreateAccount - and
// they belong in different log categories so an operator filtering Business
// Manager's Custom Log Settings for customer sync sees the CreateAccount line
// alongside the ones gameballCustomerApi and Account.js write. The alternative,
// re-pointing the existing logger at one shared category, was rejected: a
// merchant may already have a Custom Log Settings entry keyed on
// gameball_order_confirm, and silently renaming it breaks their filter with no
// symptom. The grandfathered category above is migrated when the order item
// next touches it, not by a customer-side change.
var customerLogger = require('dw/system/Logger').getLogger('Gameball', 'gameball.customer');

// The SFCC trigger that produced this sync, persisted verbatim into
// Profile.custom.gbSyncSource and logged. UPPER_SNAKE state-machine style
// rather than the route id it names, matching Account.js.
var SOURCE_ORDER_CREATE_ACCOUNT = 'ORDER_CREATE_ACCOUNT';

/**
 * Fires the Gameball order-tracking sync right after the base Confirm route
 * renders its view data. This entire block must never throw and never delay
 * or break the confirmation page - a Gameball failure has to stay invisible
 * to the shopper, so it is only ever logged.
 */
server.append('Confirm', function (req, res, next) {
    try {
        var viewData = res.getViewData();
        var orderNumber = viewData && viewData.order && viewData.order.orderNumber;

        if (orderNumber) {
            // res.getViewData().order is a plain OrderModel (only exposes
            // storefront-facing fields) - the real dw.order.Order is needed
            // for the full API surface the payload builder relies on, so it
            // is re-fetched here rather than read off the view data.
            var order = OrderMgr.getOrder(orderNumber);
            if (order) {
                gameballOrderApi.sendOrder(order);
            }
        }
    } catch (e) {
        Logger.error('Gameball order-confirmation sync did not run: {0}', e && e.message);
    }

    next();
});

/**
 * Null/exception-safe unwrap of a customer-shaped candidate to a Profile that
 * is actually usable as a Gameball upsert key.
 *
 * Asserts customerNo rather than settling for a truthy profile, for the reason
 * Account.js:20-33 documents at length: on some SFRA versions the candidate is
 * an account MODEL whose .profile is a plain object carrying firstName /
 * lastName / email and no customerNo. Accepting it would build a payload with
 * no upsert key, and every account creation on such an instance would log
 * reason=no_customer_id and never sync - while the fallback rungs that exist to
 * defend against exactly that sat below, unreached.
 *
 * @param {Object} candidate - a dw.customer.Customer, or something that hoped
 *        to be one
 * @returns {dw.customer.Profile|null}
 */
function readUsableProfile(candidate) {
    try {
        if (!candidate || typeof candidate.getProfile !== 'function') {
            return null;
        }

        var profile = candidate.getProfile();
        return (profile && profile.customerNo) ? profile : null;
    } catch (e) {
        return null;
    }
}

/**
 * Resolves the Profile that Order-CreateAccount just created, from whatever the
 * base route left behind.
 *
 * Four rungs rather than one lookup because the exact view-data keys base SFRA
 * sets on this route are UNVERIFIED across SFRA versions, and this is the
 * highest-volume guest-to-registered conversion route there is - a single
 * lookup that guesses wrong silently loses every converting shopper.
 *
 * @param {Object} req - the SFRA request
 * @param {Object} viewData - res.getViewData() of the base route
 * @returns {dw.customer.Profile|null}
 */
function resolveCreatedProfile(req, viewData) {
    // Re-guarded even though the caller has already checked it (H22): this is a
    // standalone function and a future second call site should not have to know
    // that rung 1 dereferences viewData before any try block catches it.
    if (!viewData) {
        return null;
    }

    // 1. The SFRA idiom, and exactly what the Account.js registration append
    //    reads.
    var profile = readUsableProfile(viewData.authenticatedCustomer);
    if (profile) {
        return profile;
    }

    // 2. The live dw.customer.Customer, once base has logged the new account in.
    try {
        if (req && req.currentCustomer && req.currentCustomer.raw && req.currentCustomer.raw.authenticated) {
            profile = readUsableProfile(req.currentCustomer.raw);
            if (profile) {
                return profile;
            }
        }
    } catch (e) {
        // Fall through: an unreadable currentCustomer is not a reason to stop
        // trying the two rungs that do not depend on it.
    }

    // 3. Via the order itself, which base has just re-associated to the new
    //    customer. viewData.order is a plain OrderModel, so the real
    //    dw.order.Order is re-fetched for the customer handle - the same reason
    //    the Confirm append above re-fetches it.
    try {
        var orderNumber = viewData.order && viewData.order.orderNumber;
        if (orderNumber) {
            var order = OrderMgr.getOrder(orderNumber);
            profile = order ? readUsableProfile(order.getCustomer()) : null;
            if (profile) {
                return profile;
            }
        }
    } catch (e) {
        // Fall through.
    }

    // 4. By login. Base SFRA registers with login === email.
    //    getCustomerByLogin is guarded by a typeof test because it is NOT
    //    present in the vendored dw-api-mock CustomerMgr surface, which lists
    //    only getCustomerByCustomerNumber - so its availability here is
    //    UNVERIFIED, and calling a missing method would throw inside the last
    //    rung of a chain whose whole purpose is not to throw.
    try {
        var login = viewData.email || viewData.orderEmail;
        if (login && typeof CustomerMgr.getCustomerByLogin === 'function') {
            profile = readUsableProfile(CustomerMgr.getCustomerByLogin(login));
            if (profile) {
                return profile;
            }
        }
    } catch (e) {
        // Fall through to the null return: the sweep recovers this profile
        // within one schedule interval.
    }

    return null;
}

/**
 * Upserts the account a shopper just created from the order-confirmation page.
 *
 * This closes the highest-volume guest-to-registered conversion route in the
 * storefront. Before it, such a shopper had no Gameball profile at all: they
 * earned nothing on their next order (order tracking auto-creates a bare
 * Gameball profile with no email, which then cannot channel-merge) and the
 * widget showed them the guest view forever.
 *
 * A SEPARATE server.append rather than an extension of the Confirm block above:
 * they are different routes with different failure modes, and keeping them
 * independent means a later change to order tracking cannot accidentally alter
 * customer sync, nor produce a diff that touches both.
 *
 * The work sits in route:BeforeComplete, which is now uniform across the
 * cartridge. It matters more here than elsewhere: this route ends in a
 * redirect, and whether a redirecting route emits route:Complete at all is
 * UNVERIFIED - a listener that never fires is precisely the silent failure this
 * item exists to remove.
 *
 * The whole listener is caught and only logged (H17). This page is adjacent to
 * the order confirmation, the single highest-value page in the funnel, and a
 * Gameball failure must stay invisible to the shopper.
 */
server.append('CreateAccount', function (req, res, next) {
    this.on('route:BeforeComplete', function (req, res) {
        try {
            var viewData = res.getViewData();

            // Gated on the POSITIVE signal, matching Account.js, and the
            // polarity is the whole point. Base SFRA's CreateAccount has three
            // exits, not two: success sets { success: true, redirectUrl }, a
            // failed creation sets an error array from inside base's own
            // route:BeforeComplete listener, and an INVALID PASSWORD FORM - a
            // mistyped confirmation, or a password the policy rejects - never
            // registers that listener at all and answers with a field-error
            // map instead. Our listener is registered unconditionally, so it
            // still runs on that third exit, and testing only for
            // viewData.error would admit it: no account was created, all four
            // resolver rungs would miss, and every mistyped password
            // confirmation on the confirmation page would write the ERROR line
            // below - the one line whose entire value is that it fires only on
            // a genuine anomaly.
            //
            // If a future SFRA release stopped setting success, this listener
            // skips and the hourly delta sweep picks the profile up instead,
            // which is strictly safer than running on every failed form post.
            if (!viewData || !viewData.success) {
                return;
            }

            var profile = resolveCreatedProfile(req, viewData);
            if (!profile) {
                // Worth an error line: the account was created but we could not
                // find the profile it produced, which is the one case that
                // would otherwise be completely invisible. 'present'/'absent'
                // rather than the address itself - an email is on the build
                // plan's REDACT list and a log line is not exempt.
                customerLogger.error('Order~CreateAccount could not resolve the new customer profile, Gameball sync skipped (order={0}, email={1})',
                    (viewData.order && viewData.order.orderNumber) || 'unknown',
                    (viewData.email || viewData.orderEmail) ? 'present' : 'absent');
                return;
            }

            // Return value ignored: every outcome, including every failure, is
            // already logged and persisted inside sendProfile, and there is
            // nothing this controller could usefully do differently with it.
            //
            // This route is a creation event, so there is no stored hash and
            // the call always goes out. If a future SFRA release starts firing
            // a registration event here too, the second call finds an unchanged
            // hash and no-ops - the duplicate costs nothing.
            gameballCustomerApi.sendProfile(profile, SOURCE_ORDER_CREATE_ACCOUNT);
        } catch (e) {
            customerLogger.error('Order~CreateAccount Gameball customer sync did not run: {0}', e && e.message);
        }
    });

    next();
});

module.exports = server.exports();
