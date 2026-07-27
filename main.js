"use strict";

/*
 * ioBroker Grundfos ALPHA adapter.
 *
 * Thin glue between the transport-agnostic library in lib/alpha and ioBroker
 * states. Per configured device it starts an AlphaClient, writes telemetry via
 * json2iob, and (where the model/transport support it) exposes writable control
 * states that map to AlphaClient control methods.
 */

const utils = require("@iobroker/adapter-core");
const Json2iob = require("json2iob");
const { AlphaClient, ControlMode } = require("./lib/alpha");

// Units for telemetry state keys (json2iob applies them by matching id ending).
const UNITS = {
    flow_m3h: "m³/h",
    flow_lh: "l/h",
    head_m: "m",
    power_W: "W",
    dcPower_W: "W",
    current_A: "A",
    gridVoltage_V: "V",
    dcLinkVoltage_V: "V",
    speed_rpm: "rpm",
    mediaTemperature_C: "°C",
    pcbTemperature_C: "°C",
    controlBoxTemperature_C: "°C",
    converterTemperature_C: "°C",
    inverterTemperature_C: "°C",
    auxTemperature_C: "°C",
    differentialTemperature_C: "°C",
    inletPressure_Pa: "Pa",
    outletPressure_Pa: "Pa",
    differentialPressure_Pa: "Pa",
    rssi: "dBm",
};

class Grundfos extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({ ...options, name: "grundfos" });
        this.clients = [];
        this.deviceById = new Map();
        this.json2iob = new Json2iob(this);
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    async onReady() {
        this.setState("info.connection", false, true);

        const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
        if (devices.length === 0) {
            this.log.info("No devices configured. Add pumps in the adapter settings.");
            return;
        }

        for (let i = 0; i < devices.length; i++) {
            await this._setupDevice(devices[i], i);
        }

        this.subscribeStates("*.control.*");
    }

    /**
     * Build a stable device id from the configured name (fallback to index).
     *
     * @param {object} device - device config
     * @param {number} index - position in the list
     * @returns {string} sanitized device id
     */
    _deviceId(device, index) {
        const raw = (device.name && String(device.name)) || `pump_${index}`;
        return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    async _setupDevice(device, index) {
        const id = this._deviceId(device, index);
        if (!device.address && device.transport !== "advertising") {
            this.log.warn(`Device "${id}": no address configured, skipping`);
            return;
        }

        await this.setObjectNotExistsAsync(id, {
            type: "device",
            common: { name: device.name || id },
            native: {},
        });

        let client;
        try {
            client = new AlphaClient(
                {
                    transport: device.transport,
                    model: device.model,
                    address: device.address,
                    hciDevice: this.config.hciDevice,
                    pollInterval: device.pollInterval,
                    esphomePort: device.esphomePort,
                    esphomePassword: device.esphomePassword,
                    esphomeEncryptionKey: device.esphomeEncryptionKey,
                },
                this.log,
            );
        } catch (e) {
            this.log.error(`Device "${id}": ${e.message}`);
            return;
        }

        this.deviceById.set(id, client);
        this.clients.push(client);

        client.on("telemetry", telemetry => {
            this.json2iob
                .parse(`${id}.telemetry`, telemetry, { channelName: "Telemetry", units: UNITS, write: false })
                .catch(e => this.log.debug(`json2iob error for ${id}: ${e.message}`));
        });
        client.on("connected", () => {
            this.log.info(`Device "${id}" connected`);
            this.setState("info.connection", true, true);
        });
        client.on("disconnected", () => {
            this.log.info(`Device "${id}" disconnected`);
            this._refreshConnectionState();
        });
        client.on("error", e => {
            this.log.warn(`Device "${id}" error: ${e.message}`);
            this._maybeHintPermissions(e);
        });

        if (client.supportsControl) {
            await this._createControlStates(id);
        }

        try {
            await client.start();
        } catch (e) {
            this.log.error(`Device "${id}" failed to start: ${e.message}`);
            this._maybeHintPermissions(e);
        }
    }

    async _createControlStates(id) {
        const base = `${id}.control`;
        await this.setObjectNotExistsAsync(base, { type: "channel", common: { name: "Control" }, native: {} });

        /** @type {Record<string, string>} */
        const modeStates = {};
        for (const [name, val] of Object.entries(ControlMode)) {
            modeStates[String(val)] = name;
        }
        await this.setObjectNotExistsAsync(`${base}.mode`, {
            type: "state",
            common: {
                name: "Control mode",
                type: "number",
                role: "level.mode",
                read: true,
                write: true,
                states: modeStates,
                def: ControlMode.CONSTANT_PRESSURE,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.setpoint`, {
            type: "state",
            common: {
                name: "Setpoint (m / rpm / m³h depending on mode)",
                type: "number",
                role: "level",
                read: true,
                write: true,
                def: 1.5,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.running`, {
            type: "state",
            common: {
                name: "Running (write false to stop)",
                type: "boolean",
                role: "switch.power",
                read: true,
                write: true,
                def: true,
            },
            native: {},
        });
    }

    _refreshConnectionState() {
        // Keep info.connection true while at least one client stays connected is
        // approximated by leaving it to per-device connect events; on any
        // disconnect we re-evaluate conservatively.
        const anyConnected = this.clients.length > 0;
        this.setState("info.connection", anyConnected, true);
    }

    /**
     * On typical BLE permission errors, log the exact setcap command that grants
     * Node the raw-socket capability, so the user can fix it without guessing.
     *
     * @param {Error} error - the error emitted by a client/transport
     */
    _maybeHintPermissions(error) {
        const msg = (error && error.message) || "";
        const looksLikePermission =
            /EPERM|not permitted|access denied|EACCES|LIBUSB_ERROR_ACCESS|hci|Command Disallowed/i.test(msg);
        if (!looksLikePermission || this._permissionHintShown) {
            return;
        }
        this._permissionHintShown = true;
        this.log.error(
            "BLE access was denied. On Linux, grant Node raw-socket capabilities with:\n" +
                `    sudo setcap cap_net_raw,cap_net_admin+eip $(eval readlink -f ${process.execPath})\n` +
                "then restart the adapter. This is not needed for the ESPHome transport.",
        );
    }

    /**
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        // Expect <namespace>.<deviceId>.control.<field>
        const parts = id.split(".");
        const controlIdx = parts.indexOf("control");
        if (controlIdx < 1) {
            return;
        }
        const deviceId = parts[controlIdx - 1];
        const field = parts[controlIdx + 1];
        const client = this.deviceById.get(deviceId);
        if (!client || !client.supportsControl) {
            this.log.warn(`Control for "${deviceId}" not available`);
            return;
        }

        try {
            const modeState = await this.getStateAsync(`${deviceId}.control.mode`);
            const setpointState = await this.getStateAsync(`${deviceId}.control.setpoint`);
            const mode = modeState && typeof modeState.val === "number" ? modeState.val : ControlMode.CONSTANT_PRESSURE;
            const setpoint = setpointState && typeof setpointState.val === "number" ? setpointState.val : undefined;

            if (field === "running") {
                if (state.val === false) {
                    await client.stop_pump(mode);
                } else {
                    await client.start_pump(mode);
                }
            } else if (field === "mode" || field === "setpoint") {
                await client.setMode(field === "mode" ? state.val : mode, setpoint);
            }
            await this.setStateAsync(id, { val: state.val, ack: true });
        } catch (e) {
            this.log.error(`Control command for "${deviceId}.${field}" failed: ${e.message}`);
        }
    }

    /**
     * @param {() => void} callback - Callback function
     */
    async onUnload(callback) {
        try {
            await Promise.all(this.clients.map(c => c.stop().catch(e => this.log.debug(`stop error: ${e.message}`))));
            this.clients = [];
            this.deviceById.clear();
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Grundfos(options);
} else {
    new Grundfos();
}
