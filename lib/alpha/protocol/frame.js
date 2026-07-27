"use strict";

/*
 * GENI frame framing layer.
 *
 * Frame layout (big-endian throughout):
 *   [Start][Length][Dest][Source][APDU...][CRC_H][CRC_L]
 *
 *   Start   : 0x27 request (client -> pump) or 0x24 response (pump -> client)
 *   Length  : number of bytes of (Dest + Source + APDU), excludes Start and CRC
 *   Dest    : 0xE7 (pump/service) for requests
 *   Source  : 0xF8 (client) for requests
 *   CRC     : CRC-16-CCITT over bytes[1..end-of-APDU] (i.e. Length..last APDU byte)
 *
 * The BLE ATT payload is capped at 20 bytes, so long frames arrive/leave
 * fragmented. FrameReassembler rebuilds complete frames from notification
 * fragments: a fragment starting with 0x24/0x27 begins a new frame, and a
 * frame is complete once its buffer length reaches (Length + 4).
 */

const { calcCrc16, calcCrc16Read } = require("./crc");

const FRAME_START = 0x27; // request
const RESPONSE_START = 0x24; // response
const DEST_PUMP = 0xe7;
const SOURCE_CLIENT = 0xf8;

/**
 * Build a complete GENI request frame around an APDU.
 *
 * @param {Buffer|number[]} apdu - application payload (class byte first)
 * @param {object} [opts]
 * @param {number} [opts.start] - start byte
 * @param {number} [opts.dest] - destination byte
 * @param {number} [opts.source] - source byte
 * @param {boolean} [opts.writeCrc] - use write CRC (no final XOR) instead of read CRC
 * @returns {Buffer} framed packet including CRC
 */
function buildFrame(apdu, opts = {}) {
    const start = opts.start != null ? opts.start : FRAME_START;
    const dest = opts.dest != null ? opts.dest : DEST_PUMP;
    const source = opts.source != null ? opts.source : SOURCE_CLIENT;
    const apduBuf = Buffer.from(apdu);

    const length = 2 + apduBuf.length; // dest + source + apdu
    const body = Buffer.concat([Buffer.from([length, dest, source]), apduBuf]);

    const crc = opts.writeCrc ? calcCrc16(body) : calcCrc16Read(body);
    return Buffer.concat([Buffer.from([start]), body, Buffer.from([(crc >> 8) & 0xff, crc & 0xff])]);
}

/**
 * Parse and validate a complete GENI frame.
 *
 * @param {Buffer} frame - full frame including start byte and CRC
 * @param {object} [opts]
 * @param {boolean} [opts.writeCrc] - validate with write CRC instead of read CRC
 * @returns {{start:number,length:number,dest:number,source:number,apdu:Buffer,crc:number,crcValid:boolean}}
 * @throws {Error} if the frame is too short or structurally invalid
 */
function parseFrame(frame, opts = {}) {
    const buf = Buffer.from(frame);
    if (buf.length < 5) {
        throw new Error(`frame too short: ${buf.length} bytes`);
    }
    const start = buf[0];
    const length = buf[1];
    const expectedTotal = length + 4; // start + length + (length bytes) + 2 CRC
    if (buf.length < expectedTotal) {
        throw new Error(`frame truncated: have ${buf.length}, need ${expectedTotal}`);
    }
    const dest = buf[2];
    const source = buf[3];
    const apdu = buf.subarray(4, 2 + length); // from after source up to end of APDU
    const crc = (buf[expectedTotal - 2] << 8) | buf[expectedTotal - 1];

    const body = buf.subarray(1, expectedTotal - 2); // length..last APDU byte
    const calc = opts.writeCrc ? calcCrc16(body) : calcCrc16Read(body);

    return { start, length, dest, source, apdu, crc, crcValid: calc === crc };
}

/**
 * Reassembles GENI frames from BLE notification fragments.
 *
 * BLE notifications are limited by the ATT MTU (~20 bytes), so a single
 * logical frame can span several notifications. Feed each fragment in; the
 * callback fires once per complete frame.
 */
class FrameReassembler {
    /**
     * @param {(frame: Buffer) => void} onFrame - called with each complete frame
     */
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Feed a notification fragment.
     *
     * @param {Buffer|Uint8Array} fragment - raw notification bytes
     * @returns {Buffer|null} the completed frame, or null if still incomplete
     */
    push(fragment) {
        const frag = Buffer.from(fragment);

        // A fragment that begins with a start byte starts a fresh frame.
        if (frag.length > 0 && (frag[0] === RESPONSE_START || frag[0] === FRAME_START)) {
            this.buffer = frag;
        } else {
            this.buffer = Buffer.concat([this.buffer, frag]);
        }

        if (this.buffer.length >= 2) {
            const expectedTotal = this.buffer[1] + 4;
            if (this.buffer.length >= expectedTotal) {
                const frame = this.buffer.subarray(0, expectedTotal);
                this.buffer = Buffer.alloc(0);
                if (this.onFrame) {
                    this.onFrame(frame);
                }
                return frame;
            }
        }

        // Guard against runaway buffer growth from corrupted data.
        if (this.buffer.length > 256) {
            this.buffer = Buffer.alloc(0);
        }
        return null;
    }

    /** Reset internal buffer (e.g. on reconnect). */
    reset() {
        this.buffer = Buffer.alloc(0);
    }
}

module.exports = {
    FRAME_START,
    RESPONSE_START,
    DEST_PUMP,
    SOURCE_CLIENT,
    buildFrame,
    parseFrame,
    FrameReassembler,
};
