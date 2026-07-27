"use strict";

const { Transport } = require("./Transport");
const { loadNoble } = require("./nobleLoader");
const { decodeAlphaReaderRecord } = require("../protocol/advertising");

/*
 * Passive BLE advertising transport (AlphaReader MI401).
 *
 * The MI401 dongle clips onto the pump and broadcasts telemetry in its BLE
 * advertising packets. We never connect - just scan and decode. This path is
 * read-only and works without pairing.
 *
 * The MI401 manufacturer data begins with the packet-type byte (0xF2 data,
 * 0xF0 idle). noble surfaces manufacturer data via
 * peripheral.advertisement.manufacturerData. We deduplicate by sequence number
 * to match the official app behaviour (which waits for two distinct sequences).
 */
class BleAdvertising extends Transport {
    constructor(opts) {
        super(opts);
        this.noble = null;
        this.scanning = false;
        this.lastSequence = null;
        this._onDiscover = this._onDiscover.bind(this);
        this._onStateChange = this._onStateChange.bind(this);
        // Optional MAC filter (lower-case, no separators) to target one reader.
        this.addressFilter = opts.address ? opts.address.toLowerCase().replace(/[^0-9a-f]/g, "") : null;
    }

    async start() {
        this.noble = loadNoble(this.log, this.hciDevice);
        if (!this.noble) {
            throw new Error("BLE advertising transport requires a noble implementation");
        }
        this.noble.on("discover", this._onDiscover);
        this.noble.on("stateChange", this._onStateChange);
        if (this.noble.state === "poweredOn") {
            await this._startScan();
        } else {
            this.log.debug(`BLE: waiting for adapter power on (state=${this.noble.state})`);
        }
    }

    async _onStateChange(state) {
        this.log.debug(`BLE: state changed to ${state}`);
        if (state === "poweredOn") {
            await this._startScan();
        } else if (this.scanning) {
            this.scanning = false;
            this.emit("disconnected");
        }
    }

    async _startScan() {
        // allowDuplicates=true is essential: the reader keeps the same MAC, so
        // without it we'd only see the first packet.
        await this.noble.startScanningAsync([], true);
        this.scanning = true;
        this.emit("connected");
        this.log.info("BLE: scanning for AlphaReader advertisements");
    }

    _onDiscover(peripheral) {
        try {
            const adv = peripheral.advertisement || {};
            const md = adv.manufacturerData;
            if (!md || md.length < 1) {
                return;
            }
            const addr = (peripheral.address || peripheral.id || "").toLowerCase().replace(/[^0-9a-f]/g, "");
            if (this.addressFilter && addr && addr !== this.addressFilter) {
                return;
            }

            // Ungekürztes Debug-Logging: full raw manufacturer data + rssi.
            this.log.debug(`BLE ADV RX addr=${peripheral.address} rssi=${peripheral.rssi} md=${md.toString("hex")}`);

            const decoded = decodeAlphaReaderRecord(md);
            if (!decoded || decoded.type !== "data") {
                return;
            }
            if (decoded.sequence === this.lastSequence) {
                return; // duplicate retransmission
            }
            this.lastSequence = decoded.sequence;

            const telemetry = {
                flow_lh: decoded.flow_lh,
                head_m: decoded.head_m,
                mediaTemperature_C: decoded.temperature_c,
                mode: decoded.mode,
                modeText: decoded.modeText,
                batteryStatus: decoded.batteryStatus,
                pumpId: decoded.pumpId,
                rssi: peripheral.rssi,
            };
            this.log.debug(`BLE ADV decoded: ${JSON.stringify(telemetry)}`);
            this.emit("telemetry", telemetry);
        } catch (e) {
            this.emit("error", e);
        }
    }

    async stop() {
        if (this.noble) {
            this.noble.removeListener("discover", this._onDiscover);
            this.noble.removeListener("stateChange", this._onStateChange);
            try {
                await this.noble.stopScanningAsync();
            } catch (e) {
                this.log.debug(`BLE: stopScanning error: ${e.message}`);
            }
        }
        this.scanning = false;
    }
}

module.exports = { BleAdvertising };
