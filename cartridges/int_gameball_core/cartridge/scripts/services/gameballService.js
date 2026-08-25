'use strict';

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');

/**
 * Initializes the Gameball HTTP Service for outbound API calls.
 * This service must be configured in the SFCC Business Manager under Administration > Operations > Services
 * with the name 'gameball.http.api'
 */
var gameballService = LocalServiceRegistry.createService('gameball.http.api', {
    createRequest: function (svc, params) {
        // Set HTTP Method (Default to POST)
        var method = params.method || 'POST';
        svc.setRequestMethod(method);
        
        // Ensure JSON content type
        svc.addHeader('Content-Type', 'application/json');

        // Base URL
        var BASE_URL = 'https://defender-playlist-parasail.ngrok-free.dev';

        // Append specific paths
        if (params.path) {
            var url = BASE_URL.charAt(BASE_URL.length - 1) === '/' ? BASE_URL + params.path : BASE_URL + '/' + params.path;
            svc.setURL(url);
        } else {
            svc.setURL(BASE_URL);
        }

        // Return the JSON stringified body
        return params.body ? JSON.stringify(params.body) : null;
    },
    
    parseResponse: function (svc, response) {
        // Return the raw response object (or parse JSON if necessary)
        return response;
    },
    
    getRequestLogMessage: function (request) {
        // Mask sensitive data in logs if necessary. For now, log the raw request.
        return request;
    },
    
    getResponseLogMessage: function (response) {
        return response.text;
    }
});

module.exports = gameballService;
