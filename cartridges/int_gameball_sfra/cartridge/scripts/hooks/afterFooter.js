'use strict';

/**
 * app.template.afterFooter hook - injects the Pay with Points redeem
 * panel's empty root div + deferred script tag just before </body> on
 * every page. Thin adapter (H49): all it does is render the fragment.
 *
 * See gameball/redeemInjector.isml's own module comment for the
 * cached-page-safety reasoning and the one UNVERIFIED assumption this
 * hook's wiring depends on.
 *
 * @param {Object} pdict - the page's view data
 * @returns {string}
 */
function afterFooter(pdict) {
    var ISML = require('dw/template/ISML');
    ISML.renderTemplate('gameball/redeemInjector', pdict);
}

module.exports = {
    afterFooter: afterFooter
};
