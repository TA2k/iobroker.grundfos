"use strict";

const { EventEmitter } = require("node:events");

/*
 * Base class / interface for all transports.
 *
 * A transport knows how to reach one pump via one path (passive advertising,
 * direct BLE GATT, or an ESP32 running ESPHome) and normalizes everything into
 * the same event surface so AlphaClient does not care which path is used.
 *
 * Events:
 *   "telemetry" (obj)  - a normalized, partial telemetry snapshot (merged upstream)
 *   "connected"        - transport reached the device
 *   "disconnected"     - transport lost the device
 *   "error" (err)      - non-fatal error
 *
 * Subclasses implement start()/stop() and, where supported, writeControl().
 */
class Transport extends EventEmitter {
    /**
     * @param {object} opts
     * @param {import("../models").ModelDef} opts.model - resolved model definition
     * @param {object} opts.log - logger (debug/info/warn/error)
     * @param {string} [opts.address] - device address (BLE MAC or ESP host)
     * @param {number} [opts.hciDevice] - HCI adapter index for BLE transports
     */
    constructor(opts) {
        super();
        this.model = opts.model;
        this.log = opts.log;
        this.address = opts.address;
        this.hciDevice = opts.hciDevice;
    }

    /** Begin scanning/connecting and emitting telemetry. @returns {Promise<void>} */
    async start() {
        throw new Error("start() not implemented");
    }

    /** Stop and release all resources. @returns {Promise<void>} */
    async stop() {
        throw new Error("stop() not implemented");
    }

    /**
     * Write a control command. Only meaningful for transports that support it.
     *
     * @param {object} _cmd - control command descriptor
     * @returns {Promise<void>}
     */
    async writeControl(_cmd) {
        throw new Error(`writeControl not supported by ${this.constructor.name}`);
    }

    /** Whether this transport can issue control commands. @returns {boolean} */
    get supportsControl() {
        return false;
    }
}

module.exports = { Transport };
