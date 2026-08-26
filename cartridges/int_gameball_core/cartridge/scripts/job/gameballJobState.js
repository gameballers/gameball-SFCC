'use strict';

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction = require('dw/system/Transaction');

var TYPE_ID = 'GameballJobState';

// The singleton's key. Every Gameball job reads and writes the SAME row: these
// are cursors and run markers, a handful of small fields, and one row keeps
// them together where an operator can read the whole picture on one Business
// Manager screen. A row per job was rejected for that reason alone - there is
// no contention to relieve, because no two Gameball jobs are scheduled on the
// same minute.
var SINGLETON_KEY = '1';

/**
 * Returns the GameballJobState singleton, creating it on first read.
 *
 * Auto-creation rather than an import-time seed row: a seeded row would have to
 * ship in the metadata, which means a merchant re-importing metadata could
 * silently reset a live cursor back to its shipped value. Creating it from code
 * means the row exists exactly once, from the first run onwards, and metadata
 * import never touches its contents.
 *
 * @returns {dw.object.CustomObject} the singleton
 * @throws {Error} when the custom object type is missing - i.e. the Gameball
 *         metadata was not imported. This is the one place in the cartridge
 *         that throws on purpose: a job with no state store has no cursor, no
 *         anti-backfill floor and no way to record what it did, so continuing
 *         would either sweep the entire customer base or silently sweep
 *         nothing. Failing the step with a message naming the fix is strictly
 *         better than either.
 */
function get() {
    var existing = null;

    try {
        existing = CustomObjectMgr.getCustomObject(TYPE_ID, SINGLETON_KEY);
    } catch (e) {
        throw new Error('GameballJobState could not be read - import the Gameball metadata (custom-objecttype-definitions.xml): ' + (e && e.message));
    }

    if (existing) {
        return existing;
    }

    var created = null;
    try {
        Transaction.wrap(function () {
            created = CustomObjectMgr.createCustomObject(TYPE_ID, SINGLETON_KEY);
        });
    } catch (e) {
        // Two jobs racing to create the same key is the expected shape of this
        // failure, so re-read before giving up: the other run has already
        // created the row we wanted and the correct outcome is to use it.
        // Steps declare @supports-parallel-execution false and no two Gameball
        // jobs share a schedule minute, so this should be unreachable - but a
        // manual "run now" against a running schedule is one click away in
        // Business Manager, and losing a whole sweep to that is not acceptable.
        try {
            created = CustomObjectMgr.getCustomObject(TYPE_ID, SINGLETON_KEY);
        } catch (readError) {
            created = null;
        }

        if (!created) {
            throw new Error('GameballJobState could not be created - import the Gameball metadata (custom-objecttype-definitions.xml): ' + (e && e.message));
        }
    }

    if (!created) {
        throw new Error('GameballJobState could not be created - import the Gameball metadata (custom-objecttype-definitions.xml)');
    }

    return created;
}

/**
 * Runs a mutation against the singleton inside one transaction.
 *
 * The callback receives the singleton so a caller writes several fields in ONE
 * transaction (P2) rather than opening one per attribute. Nothing here catches:
 * a caller that cannot persist its cursor needs to know, because the next run
 * would otherwise silently repeat or skip work. The job step's own boundary
 * catch is what keeps that from reaching an operator as an unhandled error.
 *
 * @param {Function} callback - receives the dw.object.CustomObject singleton
 */
function update(callback) {
    var state = get();

    Transaction.wrap(function () {
        callback(state);
    });
}

module.exports = {
    get: get,
    update: update
};
