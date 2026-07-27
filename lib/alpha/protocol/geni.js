"use strict";

/*
 * GENI protocol layer for Grundfos ALPHA pumps.
 *
 * All register addresses, object/sub IDs, struct field order and the
 * ControlMode enum below are verified against the official GENI profiles
 * shipped inside the Grundfos GO / Home apps
 * (packages/go_flutter_geni/assets/geni_profiles/geni_profile_52_*.xml).
 * The APK is the authoritative source; reference reverse-engineering
 * projects are only used for framing/timing details.
 *
 * Class 10 (DataObject) is used for telemetry and control. A Class 10 INFO
 * request addresses an object by a 3-byte register = (objId << 16) | subId,
 * sent as [0x0A, 0x03, objId, subId_H, subId_L].
 */

const { buildFrame } = require("./frame");

const CLASS_10 = 0x0a;
const OPSPEC_INFO = 0x03;

// BLE UUIDs (from BleDefinedUUIDs smali; GENI_DATA_SINGLE = 0xffd1 on the new base).
const UUID = {
    // Advertised GENI service for Alpha2/Alpha3/HWR.
    GENI_SERVICE: "0000fe5d-0000-1000-8000-00805f9b34fb",
    // Legacy service seen on older units.
    GENI_SERVICE_OLD: "0000ffe0-0000-1000-8000-00805f9b34fb",
    // Single read/write/notify characteristic used for all GENI traffic.
    GENI_CHAR: "859cffd1-036e-432a-aa28-1a0085b87ba9",
    DEVICE_INFORMATION: "0000180a-0000-1000-8000-00805f9b34fb",
};

/**
 * Telemetry data objects, verified against geni_profile_52_*.xml.
 * `objId`/`subId` are decimal; the register is (objId << 16) | subId.
 */
const TELEMETRY = {
    // ProtectedMotorStateDetails (type 256): electrical + speed + temperatures.
    MOTOR_STATE: { objId: 87, subId: 69 },
    // PumpedMediaRelatedProcessValues (type 304, Alpha2): 6 floats, no m3/h field.
    FLOW_PRESSURE_BASIC: { objId: 93, subId: 289 },
    // PumpedMediaRelatedProcessValuesExtended (type 565, Alpha3/HWR): adds m3/h + head_m.
    FLOW_PRESSURE_EXT: { objId: 93, subId: 290 },
    // MediaTemperatureInfo (type 534): media / pcb / controlbox temperatures.
    TEMPERATURE: { objId: 93, subId: 300 },
};

/**
 * ControlMode enum, verbatim from geni_profile_52_7.xml (enum ControlMode, Enum8).
 */
const ControlMode = {
    CONSTANT_PRESSURE: 0,
    PROPORTIONAL_PRESSURE: 1,
    CONSTANT_SPEED: 2,
    AUTO_ADAPT: 5,
    CONSTANT_TEMPERATURE: 6,
    CLOSED_LOOP_SENSOR: 7,
    CONSTANT_FLOW: 8,
    CONSTANT_LEVEL: 9,
    FLOW_ADAPT: 10,
    CONSTANT_DIFFERENTIAL_PRESSURE: 11,
    CONSTANT_DIFFERENTIAL_TEMPERATURE: 12,
    AUTO_ADAPT_RADIATOR: 13,
    AUTO_ADAPT_UNDERFLOOR: 14,
    AUTO_ADAPT_RADIATOR_AND_UNDERFLOOR: 15,
    CONSTANT_DOSING: 16,
    DISINFECTANT_CONTROL: 17,
    FLOCCULENT_CONTROL: 18,
    PH_CONTROL: 19,
    PID_CONTROL: 20,
    CONSTANT_RELATIVE_SETPOINT: 21,
    LEVEL_CONTROL: 22,
    ZONE_PUMP_CONTROL: 23,
    USER_DEFINED: 24,
    DHW_ON_OFF_CONTROL: 25,
    PROPORTIONAL_DIFFERENTIAL_PRESSURE: 26,
    TEMPERATURE_RANGE_CONTROL: 27,
    COMFORT_VALVE_CONTROL: 28,
    ON_OFF_CONTROL: 29,
    CONSTANT_VOLTAGE: 30,
    NONE: 254,
};

const CONTROL_MODE_NAMES = Object.fromEntries(Object.entries(ControlMode).map(([k, v]) => [v, k]));

// Meters water column -> Pascal (setpoint encoding for pressure modes).
const PA_PER_METER = 9806.65;

/*
 * Control (write) constants for the ALPHA HWR, verified against the alpha-hwr
 * reference (derived from Grundfos GO traffic captures).
 *
 * Control uses a Class 10 SET (OpSpec 0x90) to Sub 0x5600 / Obj 0x0601 with a
 * 12-byte payload: [2F 01 00 00 07 00][Flag][ModeByte][Setpoint/Suffix(4)].
 * Flag: 0x00 = start/run, 0x01 = stop. When no explicit setpoint is given a
 * mode-specific default suffix is used. After the SET, a fixed configuration
 * commit frame must be sent so the pump persists the change.
 */
const CONTROL_SUB = 0x5600;
const CONTROL_OBJ = 0x0601;
const CONTROL_OPSPEC_SET = 0x90;

// ControlMode value -> control-payload mode byte (subset that is controllable).
const MODE_BYTE_MAP = {
    [ControlMode.CONSTANT_PRESSURE]: 0x00,
    [ControlMode.PROPORTIONAL_PRESSURE]: 0x01,
    [ControlMode.CONSTANT_SPEED]: 0x02,
    [ControlMode.CONSTANT_FLOW]: 0x08,
    [ControlMode.DHW_ON_OFF_CONTROL]: 0x19,
    [ControlMode.TEMPERATURE_RANGE_CONTROL]: 0x1b,
};

// Default 4-byte suffix per mode byte when no explicit setpoint is provided.
const MODE_SUFFIX_MAP = {
    0x00: Buffer.from([0x45, 0x65, 0x70, 0x00]),
    0x01: Buffer.from([0x45, 0x65, 0x70, 0x00]),
    0x02: Buffer.from([0x45, 0x65, 0x70, 0x00]),
    0x08: Buffer.from([0x45, 0x65, 0x70, 0x00]),
    0x19: Buffer.from([0x38, 0xc6, 0x76, 0xef]),
    0x1b: Buffer.from([0x39, 0x67, 0x70, 0x00]),
};
const DEFAULT_SUFFIX = Buffer.from([0x45, 0x65, 0x70, 0x00]);

// Fixed configuration commit APDU (Class 10 SET, Sub 0x5400, Obj 0xDA01).
const CONFIG_COMMIT_APDU = Buffer.from("0A9354000100DA0100000A02050005000100000000", "hex");

/**
 * Authentication handshake packets (ALPHA HWR). Pre-computed with correct CRC.
 * Sent fire-and-forget after connecting; no response is expected.
 * Sequence: 3x legacy magic, 5x class-10 unlock, then extend1, extend2.
 */
const AUTH = {
    LEGACY_MAGIC: Buffer.from("2707e7f80203949596eb47", "hex"),
    CLASS10_UNLOCK: Buffer.from("2707e7f80a03560006c55a", "hex"),
    EXTEND_1: Buffer.from("2705e7f805c14bc382", "hex"),
    EXTEND_2: Buffer.from("2705e7f80bc10fd0c3", "hex"),
};

/**
 * Build a Class 10 INFO (read) request frame for a telemetry object.
 *
 * @param {{objId:number, subId:number}} obj - telemetry object descriptor
 * @returns {Buffer} complete request frame
 */
function buildTelemetryRequest(obj) {
    const apdu = [CLASS_10, OPSPEC_INFO, obj.objId & 0xff, (obj.subId >> 8) & 0xff, obj.subId & 0xff];
    return buildFrame(apdu);
}

/**
 * Convert a user-facing setpoint to the native units the pump expects, given a
 * control mode. Pressure modes use Pascal (meters * 9806.65); speed uses rpm;
 * flow uses m3/h; others pass through unchanged.
 *
 * @param {number} mode - ControlMode value
 * @param {number} value - user setpoint (meters / rpm / m3h depending on mode)
 * @returns {number} value in native units
 */
function encodeSetpointNative(mode, value) {
    if (mode === ControlMode.CONSTANT_PRESSURE || mode === ControlMode.PROPORTIONAL_PRESSURE) {
        return value * PA_PER_METER;
    }
    return value;
}

/**
 * Build the frame(s) for a control command: the Class 10 SET followed by the
 * configuration commit. Only meaningful for models that support control (HWR).
 *
 * @param {object} cmd
 * @param {number} cmd.mode - ControlMode value
 * @param {boolean} [cmd.start] - true to start/run, false to stop
 * @param {number} [cmd.setpoint] - optional setpoint in user units (m / rpm / m3h)
 * @returns {Buffer[]} [setFrame, commitFrame]
 */
function buildControlFrames(cmd) {
    const mode = cmd.mode;
    const modeByte = MODE_BYTE_MAP[mode];
    if (modeByte == null) {
        throw new Error(`control mode ${mode} is not controllable`);
    }

    const payload = Buffer.alloc(12);
    Buffer.from([0x2f, 0x01, 0x00, 0x00, 0x07, 0x00]).copy(payload, 0);
    payload[6] = cmd.start === false ? 0x01 : 0x00;
    payload[7] = modeByte;

    if (cmd.setpoint != null) {
        payload.writeFloatBE(encodeSetpointNative(mode, cmd.setpoint), 8);
    } else {
        (MODE_SUFFIX_MAP[modeByte] || DEFAULT_SUFFIX).copy(payload, 8);
    }

    const apdu = Buffer.concat([
        Buffer.from([
            CLASS_10,
            CONTROL_OPSPEC_SET,
            (CONTROL_SUB >> 8) & 0xff,
            CONTROL_SUB & 0xff,
            (CONTROL_OBJ >> 8) & 0xff,
            CONTROL_OBJ & 0xff,
        ]),
        payload,
    ]);

    const setFrame = buildFrame(apdu);
    const commitFrame = buildFrame(CONFIG_COMMIT_APDU);
    return [setFrame, commitFrame];
}

/**
 * Class 3 remote-mode enable frame (allow external control).
 *
 * @param enable
 */
function buildRemoteModeFrame(enable) {
    return buildFrame([0x03, 0xc1, enable ? 0x07 : 0x06]);
}

module.exports = {
    UUID,
    CLASS_10,
    OPSPEC_INFO,
    TELEMETRY,
    ControlMode,
    CONTROL_MODE_NAMES,
    MODE_BYTE_MAP,
    PA_PER_METER,
    AUTH,
    buildTelemetryRequest,
    buildControlFrames,
    buildRemoteModeFrame,
    encodeSetpointNative,
};
