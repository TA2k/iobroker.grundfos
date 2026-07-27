"use strict";

const { Transport } = require("./Transport");
const { loadNoble } = require("./nobleLoader");
const { FrameReassembler, parseFrame } = require("../protocol/frame");
const geni = require("../protocol/geni");
const { decodeMotorState, decodeFlowPressure, decodeTemperature } = require("../protocol/telemetry");

const SCAN_TIMEOUT_MS = 30000;
const CHUNK_DELAY_MS = 12; // between 20-byte BLE write chunks
const REQUEST_GAP_MS = 40; // between telemetry requests

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/*
 * Direct BLE GATT transport speaking GENI over the single characteristic
 * 859cffd1-...ffd1. Connects to the pump, (for HWR) runs the app-level auth
 * handshake, subscribes to notifications, and polls telemetry objects on an
 * interval. Frames >20 bytes are chunked; responses are reassembled.
 *
 * A single in-flight transaction lock serializes requests, since the GENI
 * characteristic has no request/response correlation of its own.
 */
class BleGatt extends Transport {
    constructor(opts) {
        super(opts);
        this.pollInterval = opts.pollInterval || 30000;
        this.noble = null;
        this.peripheral = null;
        this.characteristic = null;
        this.reassembler = new FrameReassembler(frame => this._onFrame(frame));
        this.pollTimer = null;
        this.keepAliveTimer = null;
        this.txLock = Promise.resolve();
        this.stopped = false;
        this._onData = this._onData.bind(this);
    }

    get supportsControl() {
        return this.model.supportsControl;
    }

    async start() {
        this.stopped = false;
        this.noble = loadNoble(this.log, this.hciDevice);
        if (!this.noble) {
            throw new Error("BLE GATT transport requires a noble implementation");
        }
        await this._connect();
    }

    async _connect() {
        const target = (this.address || "").toLowerCase().replace(/[^0-9a-f]/g, "");
        if (!target) {
            throw new Error("BLE GATT transport requires a device address");
        }

        this.log.info(`BLE: scanning for pump ${this.address}`);
        const peripheral = await this._findPeripheral(target);
        this.peripheral = peripheral;

        peripheral.once("disconnect", () => {
            this.log.warn(`BLE: disconnected from ${this.address}`);
            this.emit("disconnected");
            if (!this.stopped) {
                this._scheduleReconnect();
            }
        });

        await peripheral.connectAsync();
        this.log.info(`BLE: connected to ${this.address}`);

        // Alpha2/Alpha3 require an encrypted link. @stoprocent/noble runs the
        // SMP pairing (Just Works) on its own the first time the pump rejects a
        // read/write with an authentication/encryption error, so no manual
        // bonding is needed here. Just note it for diagnostics.
        if (this.model.requiresBleEncryption) {
            this.log.debug(
                `BLE: model ${this.model.name} uses an encrypted link; noble will pair automatically on first secured access. ` +
                    "First connect can take a few seconds. Press the pump's pairing button if it does not connect.",
            );
        }

        const { characteristic } = await this._discoverCharacteristic(peripheral);
        this.characteristic = characteristic;
        await characteristic.subscribeAsync();
        characteristic.on("data", this._onData);
        this.log.debug("BLE: subscribed to GENI characteristic notifications");

        if (this.model.requiresAuthHandshake) {
            await this._authenticate();
        }

        this.emit("connected");
        await this._poll();
        this.pollTimer = setInterval(() => this._poll().catch(e => this.emit("error", e)), this.pollInterval);
        // Keep-alive re-reads motor state to hold the link open between polls.
        this.keepAliveTimer = setInterval(() => {
            this._writeFrame(geni.buildTelemetryRequest(geni.TELEMETRY.MOTOR_STATE)).catch(() => {});
        }, 30000);
    }

    _findPeripheral(target) {
        return new Promise((resolve, reject) => {
            let done = false;
            const onDiscover = p => {
                const addr = (p.address || p.id || "").toLowerCase().replace(/[^0-9a-f]/g, "");
                if (addr === target) {
                    done = true;
                    this.noble.removeListener("discover", onDiscover);
                    this.noble.stopScanningAsync().catch(() => {});
                    resolve(p);
                }
            };
            this.noble.on("discover", onDiscover);
            const begin = () => this.noble.startScanningAsync([geni.UUID.GENI_SERVICE], false).catch(reject);
            if (this.noble.state === "poweredOn") {
                begin();
            } else {
                this.noble.once("stateChange", s => s === "poweredOn" && begin());
            }
            setTimeout(() => {
                if (!done) {
                    this.noble.removeListener("discover", onDiscover);
                    this.noble.stopScanningAsync().catch(() => {});
                    reject(new Error(`BLE: pump ${this.address} not found within ${SCAN_TIMEOUT_MS}ms`));
                }
            }, SCAN_TIMEOUT_MS);
        });
    }

    async _discoverCharacteristic(peripheral) {
        const svcUuids = [geni.UUID.GENI_SERVICE, geni.UUID.GENI_SERVICE_OLD].map(u => u.replace(/-/g, ""));
        const charUuid = geni.UUID.GENI_CHAR.replace(/-/g, "");
        const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(svcUuids, [charUuid]);
        const characteristic = characteristics && characteristics[0];
        if (!characteristic) {
            throw new Error("BLE: GENI characteristic not found - not an ALPHA pump?");
        }
        return { characteristic };
    }

    async _authenticate() {
        this.log.info("BLE: running GENI auth handshake");
        for (let i = 0; i < 3; i++) {
            await this._writeRaw(geni.AUTH.LEGACY_MAGIC);
            await sleep(50);
        }
        await sleep(100);
        for (let i = 0; i < 5; i++) {
            await this._writeRaw(geni.AUTH.CLASS10_UNLOCK);
            await sleep(50);
        }
        await sleep(200);
        await this._writeRaw(geni.AUTH.EXTEND_1);
        await sleep(50);
        await this._writeRaw(geni.AUTH.EXTEND_2);
        await sleep(500);
        this.log.debug("BLE: auth handshake complete");
    }

    async _poll() {
        if (!this.characteristic) {
            return;
        }
        await this._writeFrame(geni.buildTelemetryRequest(geni.TELEMETRY.MOTOR_STATE));
        await sleep(REQUEST_GAP_MS);
        await this._writeFrame(geni.buildTelemetryRequest(this.model.flowObject));
        await sleep(REQUEST_GAP_MS);
        await this._writeFrame(geni.buildTelemetryRequest(geni.TELEMETRY.TEMPERATURE));
    }

    /**
     * Serialize writes through a promise chain (transaction lock).
     *
     * @param frame
     */
    _writeFrame(frame) {
        const run = async () => {
            await this._writeRaw(frame);
        };
        this.txLock = this.txLock.then(run, run);
        return this.txLock;
    }

    async _writeRaw(data) {
        if (!this.characteristic) {
            return;
        }
        this.log.debug(`BLE TX (${data.length}B): ${data.toString("hex")}`);
        // Split into 20-byte chunks for the ATT MTU.
        for (let off = 0; off < data.length; off += 20) {
            const chunk = data.subarray(off, off + 20);
            await this.characteristic.writeAsync(chunk, true); // withoutResponse
            if (off + 20 < data.length) {
                this.log.debug(`BLE TX chunk @${off} (${chunk.length}B): ${chunk.toString("hex")}`);
                await sleep(CHUNK_DELAY_MS);
            }
        }
    }

    _onData(data) {
        this.log.debug(`BLE RX frag (${data.length}B): ${data.toString("hex")}`);
        this.reassembler.push(data);
    }

    _onFrame(frame) {
        this.log.debug(`BLE RX frame (${frame.length}B): ${frame.toString("hex")}`);
        let parsed;
        try {
            parsed = parseFrame(frame);
        } catch (e) {
            this.log.debug(`BLE RX unparseable frame: ${e.message}`);
            return;
        }
        if (!parsed.crcValid) {
            this.log.debug("BLE RX frame CRC invalid, ignoring");
            return;
        }
        // APDU: [class, opspec, objId, subId_H, subId_L, ...payload]
        const apdu = parsed.apdu;
        if (apdu.length < 5 || apdu[0] !== geni.CLASS_10) {
            return;
        }
        const objId = apdu[2];
        const subId = (apdu[3] << 8) | apdu[4];
        const payload = apdu.subarray(5);
        this.log.debug(`BLE RX obj=${objId} sub=${subId} payloadHex=${payload.toString("hex")}`);

        let telemetry = null;
        if (objId === geni.TELEMETRY.MOTOR_STATE.objId && subId === geni.TELEMETRY.MOTOR_STATE.subId) {
            telemetry = decodeMotorState(payload);
        } else if (objId === 93 && (subId === 289 || subId === 290)) {
            telemetry = decodeFlowPressure(payload);
        } else if (objId === geni.TELEMETRY.TEMPERATURE.objId && subId === geni.TELEMETRY.TEMPERATURE.subId) {
            telemetry = decodeTemperature(payload);
        }

        if (telemetry) {
            this.log.debug(`BLE RX decoded: ${JSON.stringify(telemetry)}`);
            this.emit("telemetry", telemetry);
        }
    }

    _scheduleReconnect() {
        setTimeout(() => {
            if (!this.stopped) {
                this._connect().catch(e => this.emit("error", e));
            }
        }, 5000);
    }

    async stop() {
        this.stopped = true;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.characteristic) {
            this.characteristic.removeListener("data", this._onData);
        }
        if (this.peripheral) {
            try {
                await this.peripheral.disconnectAsync();
            } catch (e) {
                this.log.debug(`BLE: disconnect error: ${e.message}`);
            }
        }
    }

    /**
     * Write a control command (HWR only). Builds a Class 10 SET frame and a
     * follow-up config commit. See geni.buildControlFrame.
     *
     * @param {object} cmd - control command from AlphaClient
     */
    async writeControl(cmd) {
        if (!this.supportsControl) {
            throw new Error(`${this.model.name} does not support control`);
        }
        const frames = geni.buildControlFrames(cmd);
        for (const f of frames) {
            await this._writeFrame(f);
            await sleep(REQUEST_GAP_MS);
        }
    }
}

module.exports = { BleGatt };
