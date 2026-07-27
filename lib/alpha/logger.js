"use strict";

/*
 * Minimal injectable logger so the library stays free of any ioBroker
 * dependency. ioBroker passes its own `this.log` (which has debug/info/warn/
 * error methods); standalone users get a console-backed default.
 */

/**
 * Normalize an arbitrary logger-like object into a guaranteed 4-method logger.
 *
 * @param {object} [log] - object with any of debug/info/warn/error
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 */
function makeLogger(log) {
    if (log && typeof log.debug === "function" && typeof log.error === "function") {
        return log;
    }

    return {
        debug: msg => console.debug(`[grundfos] ${msg}`),
        info: msg => console.info(`[grundfos] ${msg}`),
        warn: msg => console.warn(`[grundfos] ${msg}`),
        error: msg => console.error(`[grundfos] ${msg}`),
    };
}

module.exports = { makeLogger };
