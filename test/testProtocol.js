"use strict";

/*
 * Codec unit tests. These verify the pure protocol layer against known
 * test vectors extracted from the reference implementations and the official
 * GENI protocol, so the codec can be trusted without real hardware.
 */

const { expect } = require("chai");
const { calcCrc16, calcCrc16Read } = require("../lib/alpha/protocol/crc");
const { buildFrame, parseFrame, FrameReassembler } = require("../lib/alpha/protocol/frame");
const { decodeAlphaReaderRecord } = require("../lib/alpha/protocol/advertising");
const { decodeMotorState, decodeFlowPressure, decodeTemperature } = require("../lib/alpha/protocol/telemetry");
const geni = require("../lib/alpha/protocol/geni");

describe("protocol/crc", () => {
    it("calcCrc16Read matches the legacy auth packet CRC 0xEB47", () => {
        // Frame 27 07 E7 F8 02 03 94 95 96 EB 47; CRC is over bytes 07..96.
        const body = Buffer.from([0x07, 0xe7, 0xf8, 0x02, 0x03, 0x94, 0x95, 0x96]);
        expect(calcCrc16Read(body)).to.equal(0xeb47);
    });

    it("calcCrc16Read matches the class-10 unlock packet CRC 0xC55A", () => {
        const body = Buffer.from([0x07, 0xe7, 0xf8, 0x0a, 0x03, 0x56, 0x00, 0x06]);
        expect(calcCrc16Read(body)).to.equal(0xc55a);
    });

    it("calcCrc16 (write variant) differs from the read variant by the final XOR", () => {
        const body = Buffer.from([0x07, 0xe7, 0xf8, 0x02, 0x03, 0x94, 0x95, 0x96]);
        expect(calcCrc16(body) ^ 0xffff).to.equal(calcCrc16Read(body));
    });
});

describe("protocol/frame", () => {
    it("buildFrame reproduces the legacy auth packet", () => {
        const frame = buildFrame([0x02, 0x03, 0x94, 0x95, 0x96]);
        expect(frame.toString("hex")).to.equal("2707e7f80203949596eb47");
    });

    it("buildFrame reproduces the class-10 unlock packet", () => {
        const frame = buildFrame([0x0a, 0x03, 0x56, 0x00, 0x06]);
        expect(frame.toString("hex")).to.equal("2707e7f80a03560006c55a");
    });

    it("parseFrame round-trips a built frame with a valid CRC", () => {
        const apdu = [0x0a, 0x03, 0x57, 0x00, 0x45];
        const frame = buildFrame(apdu);
        const parsed = parseFrame(frame);
        expect(parsed.start).to.equal(0x27);
        expect(parsed.dest).to.equal(0xe7);
        expect(parsed.source).to.equal(0xf8);
        expect(parsed.crcValid).to.equal(true);
        expect([...parsed.apdu]).to.deep.equal(apdu);
    });

    it("parseFrame flags a corrupted CRC", () => {
        const frame = buildFrame([0x0a, 0x03, 0x57, 0x00, 0x45]);
        frame[frame.length - 1] ^= 0xff;
        expect(parseFrame(frame).crcValid).to.equal(false);
    });

    it("parseFrame throws on a truncated frame", () => {
        expect(() => parseFrame(Buffer.from([0x24, 0x12, 0x00]))).to.throw();
    });
});

describe("protocol/frame FrameReassembler", () => {
    it("emits a frame delivered in a single fragment", () => {
        const frames = [];
        const ra = new FrameReassembler((f) => frames.push(f.toString("hex")));
        const frame = buildFrame([0x0a, 0x03, 0x57, 0x00, 0x45]);
        ra.push(frame);
        expect(frames).to.deep.equal([frame.toString("hex")]);
    });

    it("reassembles a frame split across two fragments", () => {
        const frames = [];
        const ra = new FrameReassembler((f) => frames.push(f));
        // Build a >20 byte response frame: start 0x24, length picks total.
        const apdu = Buffer.concat([Buffer.from([0x0a, 0x0e, 0x00, 0x45, 0x00, 0x57]), Buffer.alloc(20, 0)]);
        const frame = buildFrame(apdu, { start: 0x24 });
        ra.push(frame.subarray(0, 20));
        expect(frames.length).to.equal(0); // not complete yet
        ra.push(frame.subarray(20));
        expect(frames.length).to.equal(1);
        expect(frames[0].toString("hex")).to.equal(frame.toString("hex"));
    });

    it("starts a new frame when a fragment begins with a start byte", () => {
        const frames = [];
        const ra = new FrameReassembler((f) => frames.push(f));
        ra.push(Buffer.from([0x24, 0xff])); // bogus partial, will be discarded by next start
        const frame = buildFrame([0x0a, 0x03, 0x57, 0x00, 0x45], { start: 0x24 });
        ra.push(frame);
        expect(frames.length).to.equal(1);
        expect(frames[0].toString("hex")).to.equal(frame.toString("hex"));
    });
});

describe("protocol/advertising (MI401)", () => {
    // Example F2 record from the AlphaDecoder README layout section.
    const record = Buffer.from([
        0xf2, 0x11, 0x01, 0x2e, 0x02, 0x00, 0x24, 0x09, 0x06, 0xc4, 0x0e, 0x31, 0x04, 0x15, 0x01, 0xf0,
    ]);

    it("decodes flow as int16 LE / 6.5534", () => {
        const d = decodeAlphaReaderRecord(record);
        // bytes 09 06 -> 0x0609 = 1545; 1545 / 6.5534 = 235.75 -> 236
        expect(d.flow_lh).to.equal(236);
    });

    it("decodes head as int16 LE / 3276.7", () => {
        const d = decodeAlphaReaderRecord(record);
        // bytes C4 0E -> 0x0EC4 = 3780; 3780 / 3276.7 = 1.1536 -> 1.15
        expect(d.head_m).to.equal(1.15);
    });

    it("decodes mode, temperature and sequence", () => {
        const d = decodeAlphaReaderRecord(record);
        expect(d.mode).to.equal(0x04);
        expect(d.modeText).to.equal("Proportionaldruck Stufe 1");
        expect(d.temperature_c).to.equal(0x15);
        expect(d.sequence).to.equal(0x2e);
    });

    it("reports idle for an F0 record", () => {
        const d = decodeAlphaReaderRecord(Buffer.from([0xf0, 0, 0, 0, 0, 0, 0x42]));
        expect(d.type).to.equal("idle");
    });

    it("returns null for non-F2/F0 records", () => {
        expect(decodeAlphaReaderRecord(Buffer.from([0xf1, 0x00]))).to.equal(null);
    });
});

describe("protocol/telemetry decoders", () => {
    it("decodes motor state (obj 87/69) against the known vector", () => {
        // 43700000=240.0V, 40200000=2.5A@off8, 43160000=150.0W@off16, 453b8000=3000rpm@off20
        const payload = Buffer.from("4370000000000000402000000000000043160000453b8000", "hex");
        const d = decodeMotorState(payload);
        expect(d.gridVoltage_V).to.equal(240.0);
        expect(d.current_A).to.equal(2.5);
        expect(d.dcPower_W).to.equal(150.0);
        expect(d.speed_rpm).to.equal(3000);
    });

    it("decodes flow/pressure (extended) with pre-converted fields", () => {
        // 3f800000=1.0, 3fc00000=1.5, 40400000=3.0, 40400000=3.0 (offsets 0,4,8,12)
        const payload = Buffer.from("3f8000003fc000004040000040400000", "hex");
        const d = decodeFlowPressure(payload);
        // no extended fields present (<28 bytes) -> flow = 1.0 m3/s * 3600
        expect(d.flow_m3h).to.equal(3600.0);
        expect(d.inletPressure_Pa).to.equal(3);
    });

    it("prefers pre-converted m3/h and head_m when the extended object is present", () => {
        // Build 36-byte extended payload: flow_m3s=1.0, ..., flow_m3h=2.0@24, head_m=1.5@28
        const buf = Buffer.alloc(36);
        buf.writeFloatBE(1.0, 0); // pump_flow m3/s
        buf.writeFloatBE(9806.65, 4); // diff pressure Pa
        buf.writeFloatBE(2.0, 24); // pump_flow_m3h
        buf.writeFloatBE(1.5, 28); // pump_differential_pressure_m
        const d = decodeFlowPressure(buf);
        expect(d.flow_m3h).to.equal(2.0); // uses pre-converted field, not 1.0*3600
        expect(d.head_m).to.equal(1.5);
    });

    it("decodes temperature (obj 93/300)", () => {
        // 42340000=45.0, 42480000=50.0, 428c0000=70.0
        const payload = Buffer.from("4234000042480000428c0000", "hex");
        const d = decodeTemperature(payload);
        expect(d.mediaTemperature_C).to.equal(45.0);
        expect(d.pcbTemperature_C).to.equal(50.0);
        expect(d.controlBoxTemperature_C).to.equal(70.0);
    });
});

describe("protocol/geni requests", () => {
    it("builds a valid motor-state telemetry request", () => {
        const frame = geni.buildTelemetryRequest(geni.TELEMETRY.MOTOR_STATE);
        // 27 07 E7 F8 0A 03 57 00 45 <crc> ; obj 87=0x57, sub 69=0x0045
        expect(frame.subarray(0, 9).toString("hex")).to.equal("2707e7f80a03570045");
        // last two bytes are a valid read CRC
        const { parseFrame } = require("../lib/alpha/protocol/frame");
        expect(parseFrame(frame).crcValid).to.equal(true);
    });

    it("has the authoritative ControlMode enum from the APK", () => {
        expect(geni.ControlMode.CONSTANT_PRESSURE).to.equal(0);
        expect(geni.ControlMode.DHW_ON_OFF_CONTROL).to.equal(25);
        expect(geni.ControlMode.TEMPERATURE_RANGE_CONTROL).to.equal(27);
        expect(geni.CONTROL_MODE_NAMES[8]).to.equal("CONSTANT_FLOW");
    });
});

describe("protocol/geni control frames", () => {
    const { parseFrame } = require("../lib/alpha/protocol/frame");

    it("builds a start-in-constant-pressure SET frame with default suffix", () => {
        const [setFrame, commit] = geni.buildControlFrames({ mode: geni.ControlMode.CONSTANT_PRESSURE, start: true });
        const p = parseFrame(setFrame);
        expect(p.crcValid).to.equal(true);
        // APDU: 0A 90 56 00 06 01 | 2F 01 00 00 07 00 | 00(flag) 00(mode) | 45 65 70 00
        expect(p.apdu.subarray(0, 6).toString("hex")).to.equal("0a90560006 01".replace(/\s/g, ""));
        expect(p.apdu[12]).to.equal(0x00); // flag = start
        expect(p.apdu[13]).to.equal(0x00); // mode byte = constant pressure
        expect(p.apdu.subarray(14, 18).toString("hex")).to.equal("45657000");
        // commit frame is the fixed config-commit APDU and has a valid CRC
        expect(parseFrame(commit).crcValid).to.equal(true);
    });

    it("encodes a pressure setpoint in Pascal as float32 BE", () => {
        const [setFrame] = geni.buildControlFrames({ mode: geni.ControlMode.CONSTANT_PRESSURE, setpoint: 1.5 });
        const p = parseFrame(setFrame);
        const pa = p.apdu.subarray(14, 18).readFloatBE(0);
        expect(Math.round(pa)).to.equal(Math.round(1.5 * geni.PA_PER_METER)); // ~14710 Pa
    });

    it("sets the stop flag for a stop command", () => {
        const [setFrame] = geni.buildControlFrames({ mode: geni.ControlMode.CONSTANT_SPEED, start: false });
        expect(parseFrame(setFrame).apdu[12]).to.equal(0x01);
    });

    it("rejects an uncontrollable mode", () => {
        expect(() => geni.buildControlFrames({ mode: geni.ControlMode.AUTO_ADAPT })).to.throw();
    });
});

describe("library index", () => {
    it("loads and exposes the public API", () => {
        const lib = require("../lib/alpha");
        expect(lib.AlphaClient).to.be.a("function");
        expect(lib.ControlMode.CONSTANT_PRESSURE).to.equal(0);
        expect(lib.MODELS.hwr.supportsControl).to.equal(true);
        expect(lib.MODELS.alpha3.flowObject.subId).to.equal(289);
    });
});
