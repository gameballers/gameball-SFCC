'use strict';

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');

var SERVICE_ID = 'gameball.http.api';
var DEFAULT_BASE_URL = 'https://api.gameball.co/api/v4.0';

/**
 * This service handle is never used to make an HTTP call - it exists purely so
 * the API Key / Secret Key / Base URL configured on the "gameball.http.api.cred"
 * Service Credential (Business Manager > Administration > Operations > Services)
 * can be read from contexts outside a createRequest() callback, e.g. widget.isml.
 * createRequest is defensive: if this handle is ever accidentally .call()'d, it
 * fails loudly instead of sending a broken, unauthenticated request.
 */
var credentialHandle = LocalServiceRegistry.createService(SERVICE_ID, {
    createRequest: function () {
        throw new Error('gameballCredentials internal service handle must never execute a request.');
    }
});

function getCredential() {
    return credentialHandle.getConfiguration().getCredential();
}

/**
 * Public workspace API key (Service Credential "User ID" field).
 * Safe to use in client-facing code (ISML templates).
 * @returns {string}
 */
function getApiKey() {
    var credential = getCredential();
    return (credential && credential.getUser()) || '';
}

/**
 * Points-transactions Secret Key (Service Credential "Password" field).
 * SERVER-SIDE ONLY. Never call this from an ISML template, a controller
 * response body, or any code path whose output reaches the browser.
 * @returns {string}
 */
function getSecretKey() {
    var credential = getCredential();
    return (credential && credential.getPassword()) || '';
}

/**
 * Base URL for Gameball's API. Not secret - falls back to the documented
 * default if the admin hasn't overridden the credential's URL field.
 * @returns {string}
 */
function getBaseUrl() {
    var credential = getCredential();
    var url = credential && credential.getURL();
    return url || DEFAULT_BASE_URL;
}

/**
 * True once an admin has filled in the Service Credential via Business Manager.
 * Only checks the API Key: the Secret Key is conditionally required depending
 * on the endpoint / High Security Mode, so gating the whole integration on it
 * would be wrong - a missing-but-required Secret Key should surface as a
 * Gameball-side auth error in the log, not a silent SFCC-side block.
 * @returns {boolean}
 */
function isConfigured() {
    return !!getApiKey();
}

module.exports = {
    getApiKey: getApiKey,
    getSecretKey: getSecretKey,
    getBaseUrl: getBaseUrl,
    isConfigured: isConfigured
};
