"use strict";

/*
 * Passive decoder for the Grundfos AlphaReader MI401 dongle.
 *
 * The MI401 clips onto the pump and continuously broadcasts BLE advertising
 * packets. No connection or pairing is needed - we only listen. The payload
 * of interest sits in the manufacturer-specific data.
 *
 * Packet layout (from reverse engineering, AlphaDecoder). The manufacturer
 * data payload we care about is the F1/F2 record; byte offsets below are into
 * that record:
 *   [0] packet type: 0xF2 (data), 0xF0 (reader not seated / pump off), 0xF1 (extended)
 *   [1] unknown
 *   [2] protocol version (uncertain)
 *   [3] sequence number
 *   [4] battery status indicator (uncertain)
 *   [5..6] pump identification number
 *   [7..8] flow, int16 little-endian, value / 6.5534 = l/h
 *   [9..10] head, int16 little-endian, value / 3276.7 = meters
 *   [11] unknown (possibly a sequence counter)
 *   [12] pump mode (see PUMP_MODES)
 *   [13] pump housing temperature in degrees C
 *   [14] unknown (toggles 0/1)
 *   [15] unknown (increments in steps of 4)
 *   [16..19] unknown
 * RSSI comes from the BLE scan, not the payload: rssi_dbm = raw - 256.
 */

const PUMP_MODES = {
    0x00: "Konstantdrehzahl Stufe 3",
    0x01: "Konstantdrehzahl Stufe 2",
    0x02: "Konstantdrehzahl Stufe 1",
    0x03: "Autoadapt",
    0x04: "Proportionaldruck Stufe 1",
    0x05: "Proportionaldruck Stufe 2",
    0x06: "Proportionaldruck Stufe 3",
    0x07: "Konstantdifferenzdruck Stufe 1",
    0x08: "Konstantdifferenzdruck Stufe 2",
    0x09: "Konstantdifferenzdruck Stufe 3",
};

const PACKET_DATA = 0xf2;
const PACKET_IDLE = 0xf0;
const PACKET_EXTENDED = 0xf1;

/**
 * Decode an MI401 F2 data record.
 *
 * @param {Buffer|Uint8Array} record - manufacturer data record starting at the packet-type byte
 * @returns {object|null} decoded telemetry, or null if not a decodable F2 record
 */
function decodeAlphaReaderRecord(record) {
    const buf = Buffer.from(record);
    if (buf.length < 1) {
        return null;
    }
    const type = buf[0];

    if (type === PACKET_IDLE) {
        return {
            type: "idle",
            batteryStatus: buf.length > 6 ? buf[6] : null,
        };
    }

    if (type !== PACKET_DATA) {
        // F1 extended and anything else are not decoded here.
        return null;
    }

    if (buf.length < 14) {
        return null;
    }

    const flowRaw = buf.readInt16LE(7);
    const headRaw = buf.readInt16LE(9);

    return {
        type: "data",
        protocolVersion: buf[2],
        sequence: buf[3],
        batteryStatus: buf[4],
        pumpId: buf.readUInt16LE(5),
        flow_lh: Math.round(flowRaw / 6.5534),
        head_m: Math.round((headRaw / 3276.7) * 100) / 100,
        mode: buf[12],
        modeText: PUMP_MODES[buf[12]] || "Unbekannter Pumpenmodus",
        temperature_c: buf[13],
    };
}

module.exports = {
    PUMP_MODES,
    PACKET_DATA,
    PACKET_IDLE,
    PACKET_EXTENDED,
    decodeAlphaReaderRecord,
};
