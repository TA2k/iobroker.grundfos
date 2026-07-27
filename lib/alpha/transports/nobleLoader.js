"use strict";

/*
 * Optional noble loader. noble is an optionalDependency so the adapter can run
 * with only the ESPHome transport on systems without a BLE stack. We try the
 * actively-maintained @stoprocent/noble first, then @abandonware/noble.
 */

let cached;

/**
 * Load a noble implementation, or return null if none is installed.
 *
 * @param {object} log - logger for diagnostics
 * @returns {object|null} noble instance or null
 */
function loadNoble(log) {
    if (cached !== undefined) {
        return cached;
    }
    for (const name of ["@stoprocent/noble", "@abandonware/noble"]) {
        try {
            cached = require(name);
            if (log) {
                log.debug(`BLE: using ${name}`);
            }
            return cached;
        } catch (e) {
            if (log) {
                log.debug(`BLE: ${name} not available: ${e.message}`);
            }
        }
    }
    cached = null;
    if (log) {
        log.warn("BLE: no noble implementation installed; BLE transports unavailable");
    }
    return cached;
}

module.exports = { loadNoble };
