"use strict";

const { EventEmitter } = require("events");
const { makeLogger } = require("./logger");
const { getModel } = require("./models");
const geni = require("./protocol/geni");
const { BleAdvertising } = require("./transports/BleAdvertising");
const { BleGatt } = require("./transports/BleGatt");
const { EsphomeApi } = require("./transports/EsphomeApi");

/*
 * AlphaClient - the public entry point for one pump.
 *
 * It picks a transport based on config, forwards normalized telemetry, and
 * exposes control methods (setMode / setSetpoint / start / stop) that only
 * work when the model and transport support control.
 *
 * Events (re-emitted from the transport):
 *   "telemetry" (obj)  - merged running snapshot of all known values
 *   "connected"        - device reachable
 *   "disconnected"     - device lost
 *   "error" (err)      - non-fatal error
 */
/**
 * Public entry point for one pump. See module comment above.
 */
class AlphaClient extends EventEmitter {
    /**
     * @param {object} config
     * @param {string} config.transport - "advertising" | "gatt" | "esphome"
     * @param {string} config.model - model id (see models.js)
     * @param {string} config.address - BLE MAC or ESP host
     * @param {number} [config.hciDevice] - HCI adapter index for BLE transports
     * @param {number} [config.pollInterval] - poll interval in ms (gatt)
     * @param {number} [config.esphomePort]
     * @param {string} [config.esphomePassword]
     * @param {string} [config.esphomeEncryptionKey]
     * @param {object} [log] - logger (ioBroker this.log or similar)
     */
    constructor(config, log) {
        super();
        this.config = config;
        this.log = makeLogger(log);
        this.model = getModel(config.model);
        this.state = {}; // merged telemetry snapshot
        this.transport = this._createTransport();
        this._wire();
    }

    /**
     * Instantiate the transport implementation named in the config.
     *
     * @returns {import("./transports/Transport").Transport}
     */
    _createTransport() {
        const opts = {
            model: this.model,
            log: this.log,
            address: this.config.address,
            hciDevice: this.config.hciDevice,
            pollInterval: this.config.pollInterval,
            esphomePort: this.config.esphomePort,
            esphomePassword: this.config.esphomePassword,
            esphomeEncryptionKey: this.config.esphomeEncryptionKey,
        };
        switch (this.config.transport) {
            case "advertising":
                return new BleAdvertising(opts);
            case "gatt":
                return new BleGatt(opts);
            case "esphome":
                return new EsphomeApi(opts);
            default:
                throw new Error(`unknown transport "${this.config.transport}"`);
        }
    }

    /**
     * Subscribe to transport events and re-emit them, merging telemetry into a
     * running snapshot.
     */
    _wire() {
        this.transport.on("telemetry", partial => {
            Object.assign(this.state, partial);
            this.emit("telemetry", { ...this.state });
        });
        this.transport.on("connected", () => this.emit("connected"));
        this.transport.on("disconnected", () => this.emit("disconnected"));
        this.transport.on("error", e => this.emit("error", e));
    }

    /** Whether control commands are available for this pump/transport. @returns {boolean} */
    get supportsControl() {
        return this.model.supportsControl && this.transport.supportsControl;
    }

    /** Start the transport. @returns {Promise<void>} */
    start() {
        return this.transport.start();
    }

    /** Stop the transport and release resources. @returns {Promise<void>} */
    stop() {
        return this.transport.stop();
    }

    /**
     * Throw if control is not supported by this model/transport combination.
     */
    _ensureControllable() {
        if (!this.supportsControl) {
            throw new Error(`control not supported for model=${this.model.id} transport=${this.config.transport}`);
        }
    }

    /**
     * Set the control mode, optionally with a setpoint, and start the pump.
     *
     * @param {number} mode - ControlMode value (see geni.ControlMode)
     * @param {number} [setpoint] - setpoint in user units (m / rpm / m3h)
     * @returns {Promise<void>}
     */
    async setMode(mode, setpoint) {
        this._ensureControllable();
        await this.transport.writeControl({ mode, setpoint, start: true });
    }

    /**
     * Set a setpoint for a given mode.
     *
     * @param {number} mode - ControlMode value
     * @param {number} setpoint - setpoint in user units
     * @returns {Promise<void>}
     */
    async setSetpoint(mode, setpoint) {
        this._ensureControllable();
        await this.transport.writeControl({ mode, setpoint, start: true });
    }

    /**
     * Start (run) the pump in a given mode.
     *
     * @param {number} mode - ControlMode value
     * @returns {Promise<void>}
     */
    async start_pump(mode) {
        this._ensureControllable();
        await this.transport.writeControl({ mode, start: true });
    }

    /**
     * Stop the pump in a given mode.
     *
     * @param {number} mode - ControlMode value
     * @returns {Promise<void>}
     */
    async stop_pump(mode) {
        this._ensureControllable();
        await this.transport.writeControl({ mode, start: false });
    }
}

module.exports = { AlphaClient, ControlMode: geni.ControlMode };
