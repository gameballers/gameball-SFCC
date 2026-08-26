'use strict';

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
var gameballCredentials = require('../services/gameballCredentials');

/**
 * Gameball HTTP Service for outbound API calls. Configured entirely via
 * Business Manager Service Credentials (Administration > Operations >
 * Services > Service Credentials, id "gameball.http.api.cred") - see
 * gameballCredentials.js, the only module allowed to read that credential.
 */
var gameballService = LocalServiceRegistry.createService('gameball.http.api', {
    createRequest: function (svc, params) {
        // Set HTTP Method (Default to POST)
        var method = params.method || 'POST';
        svc.setRequestMethod(method);

        // CRITICAL: Prevent SFCC from automatically sending the User/Password as a Basic Auth header!
        svc.setAuthentication('NONE');
        // Auth + content type headers required on every Gameball API call
        // Auth + content type headers required on every Gameball API call
        svc.addHeader('Content-Type', 'application/json');
        svc.addHeader('APIKey', gameballCredentials.getApiKey());
        svc.addHeader('SecretKey', gameballCredentials.getSecretKey());

        // Base URL comes from the Service Credential, not a hardcoded literal
        var baseUrl = gameballCredentials.getBaseUrl();

        // Append specific paths
        if (params.path) {
            var url = baseUrl.charAt(baseUrl.length - 1) === '/' ? baseUrl + params.path : baseUrl + '/' + params.path;
            svc.setURL(url);
        } else {
            svc.setURL(baseUrl);
        }

        // Return the JSON stringified body
        return params.body ? JSON.stringify(params.body) : null;
    },

    parseResponse: function (svc, response) {
        // Parse the JSON body when present so callers get a usable object
        // via result.getObject(); fall back to raw text if it isn't valid JSON.
        if (response && response.text) {
            try {
                return JSON.parse(response.text);
            } catch (e) {
                return response.text;
            }
        }
        return response;
    },

    getRequestLogMessage: function (request) {
        // `request` is the JSON body string returned by createRequest above.
        // APIKey/SecretKey are sent as headers, never in this body, so there
        // is nothing secret to scrub here. The real leak vector is the BM
        // Communication Log (comm-log-enabled in services.xml) - keep that
        // disabled for this service once real credentials are configured.
        return request;
    },

    getResponseLogMessage: function (response) {
        return response && response.text ? response.text : '';
    }
});

module.exports = gameballService;
