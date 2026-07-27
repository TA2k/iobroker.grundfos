"use strict";

const { Transport } = require("./Transport");

/*
 * ESP32-over-ESPHome transport.
 *
 * An ESP32 running the ESPHome alpha3/alpha_hwr component does the BLE work
 * (including any pairing/encryption) and exposes the pump as ESPHome entities.
 * We connect to the ESP32's native API and map its sensor entities onto the
 * same normalized telemetry event the other transports emit.
 *
 * The ESPHome client library (@2colors/esphome-native-api) is an optional-ish
 * dependency; we load it lazily so a BLE-only install still works.
 */

// Map common ESPHome entity object-ids / names to our normalized keys.
const ENTITY_MAP = [
    { keys: ["flow", "pump_flow"], field: "flow_m3h" },
    { keys: ["head", "pressure", "pump_pressure"], field: "head_m" },
    { keys: ["power", "pump_power"], field: "power_W" },
    { keys: ["current", "motor_current"], field: "current_A" },
    { keys: ["voltage", "pump_voltage"], field: "gridVoltage_V" },
    { keys: ["speed", "rpm", "motor_speed"], field: "speed_rpm" },
    { keys: ["temperature", "media_temperature", "water_temperature"], field: "mediaTemperature_C" },
    { keys: ["pcb_temperature"], field: "pcbTemperature_C" },
];

class EsphomeApi extends Transport {
    constructor(opts) {
        super(opts);
        this.host = opts.address;
        this.port = opts.esphomePort || 6053;
        this.password = opts.esphomePassword || "";
        this.encryptionKey = opts.esphomeEncryptionKey || undefined;
        this.client = null;
        this.entityFieldById = new Map();
    }

    async start() {
        let Client;
        try {
            ({ Client } = require("@2colors/esphome-native-api"));
        } catch (e) {
            throw new Error(`ESPHome transport requires @2colors/esphome-native-api: ${e.message}`);
        }

        this.client = new Client({
            host: this.host,
            port: this.port,
            password: this.password,
            encryptionKey: this.encryptionKey,
            reconnect: true,
            clientInfo: "ioBroker.grundfos",
        });
        // The published .d.ts lags the runtime API (connect/disconnect,
        // "connected"/"newEntity" events); use the documented runtime surface.
        const client = /** @type {any} */ (this.client);

        client.on("connected", () => {
            this.log.info(`ESPHome: connected to ${this.host}:${this.port}`);
            this.emit("connected");
        });
        client.on("disconnected", () => {
            this.log.warn(`ESPHome: disconnected from ${this.host}`);
            this.emit("disconnected");
        });
        client.on("error", e => this.emit("error", e));

        // Learn which entity keys map to which normalized field.
        client.on("newEntity", entity => {
            const cfg = entity.config || {};
            const name = `${cfg.objectId || cfg.uniqueId || cfg.name || ""}`.toLowerCase();
            const match = ENTITY_MAP.find(m => m.keys.some(k => name.includes(k)));
            if (match) {
                this.entityFieldById.set(cfg.key, match.field);
                this.log.debug(`ESPHome: mapped entity "${name}" (key=${cfg.key}) -> ${match.field}`);
            } else {
                this.log.debug(`ESPHome: unmapped entity "${name}" (key=${cfg.key})`);
            }
            if (entity.on) {
                entity.on("state", state => this._onState(cfg.key, state));
            }
        });

        client.connect();
    }

    _onState(key, state) {
        this.log.debug(`ESPHome STATE key=${key} raw=${JSON.stringify(state)}`);
        const field = this.entityFieldById.get(key);
        if (!field) {
            return;
        }
        const value = state && typeof state.state === "number" ? state.state : state && state.state;
        if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
            return;
        }
        this.emit("telemetry", { [field]: value });
    }

    async stop() {
        if (this.client) {
            try {
                /** @type {any} */ (this.client).disconnect();
            } catch (e) {
                this.log.debug(`ESPHome: disconnect error: ${e.message}`);
            }
            this.client = null;
        }
    }
}

module.exports = { EsphomeApi };
