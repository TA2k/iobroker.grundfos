"use strict";

/*
 * Telemetry decoders for GENI Class 10 data objects.
 *
 * Field order and offsets are taken verbatim from the official GENI profiles
 * (geni_profile_52_7.xml). Every field is a big-endian IEEE-754 float32 laid
 * out sequentially in the object payload:
 *
 *   ProtectedMotorStateDetails (type 256, obj 87 / sub 69):
 *     0 grid_voltage(V) 4 dc_link_voltage(V) 8 current(A) 12 power_consumption(W)
 *     16 dc_power_consumption(W) 20 absolute_speed(rpm) 24 converter_temperature(C)
 *     28 inverter_temperature(C) 32 aux_temperature(C)
 *
 *   PumpedMediaRelatedProcessValues (type 304, obj 93 / sub 289, Alpha2):
 *     0 pump_flow(m3/s) 4 pump_differential_pressure(Pa) 8 inlet_pressure(Pa)
 *     12 outlet_pressure(Pa) 16 media_temperature(C) 20 differential_temperature(C)
 *
 *   PumpedMediaRelatedProcessValuesExtended (type 565, obj 93 / sub 290, Alpha3/HWR):
 *     ...as above plus 24 pump_flow_m3h(m3/h) 28 pump_differential_pressure_m(m)
 *     32 flow_coefficient_kv
 *
 *   MediaTemperatureInfo (type 534, obj 93 / sub 300):
 *     0 media_temperature(C) 4 pcb_temperature(C) 8 controlbox_temperature(C)
 *
 * The pump reports pump_flow in m3/s; multiply by 3600 for m3/h. The extended
 * object also carries a pre-converted m3/h and head-in-meters field, which we
 * prefer when present.
 */

/**
 * Read a big-endian float32 at offset, or null if out of range/NaN.
 *
 * @param buf
 * @param off
 */
function readF32(buf, off) {
    if (off + 4 > buf.length) {
        return null;
    }
    const v = buf.readFloatBE(off);
    return Number.isFinite(v) ? v : null;
}

/**
 * Round to a sane number of decimals for display.
 *
 * @param v
 * @param decimals
 */
function round(v, decimals) {
    if (v == null) {
        return null;
    }
    const f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
}

/**
 * Decode ProtectedMotorStateDetails (obj 87 / sub 69).
 *
 * @param {Buffer} payload - object payload (after the frame/object header)
 * @returns {object} decoded electrical + speed + temperature values
 */
function decodeMotorState(payload) {
    const buf = Buffer.from(payload);
    return {
        gridVoltage_V: round(readF32(buf, 0), 1),
        dcLinkVoltage_V: round(readF32(buf, 4), 1),
        current_A: round(readF32(buf, 8), 3),
        power_W: round(readF32(buf, 12), 1),
        dcPower_W: round(readF32(buf, 16), 1),
        speed_rpm: round(readF32(buf, 20), 0),
        converterTemperature_C: round(readF32(buf, 24), 1),
        inverterTemperature_C: round(readF32(buf, 28), 1),
        auxTemperature_C: round(readF32(buf, 32), 1),
    };
}

/**
 * Decode PumpedMediaRelatedProcessValues / ...Extended (obj 93 / sub 289 or 290).
 * The extended variant (>= 32 bytes) carries pre-converted m3/h and head-in-m.
 *
 * @param {Buffer} payload - object payload
 * @returns {object} decoded flow / pressure / temperature values
 */
function decodeFlowPressure(payload) {
    const buf = Buffer.from(payload);
    const flowM3s = readF32(buf, 0);
    const diffPa = readF32(buf, 4);

    // Prefer the pre-converted fields from the extended object when available.
    const flowM3hExt = buf.length >= 28 ? readF32(buf, 24) : null;
    const headMExt = buf.length >= 32 ? readF32(buf, 28) : null;

    return {
        flow_m3h: round(flowM3hExt != null ? flowM3hExt : flowM3s != null ? flowM3s * 3600 : null, 3),
        differentialPressure_Pa: round(diffPa, 0),
        head_m: round(headMExt != null ? headMExt : diffPa != null ? diffPa / 9806.65 : null, 3),
        inletPressure_Pa: round(readF32(buf, 8), 0),
        outletPressure_Pa: round(readF32(buf, 12), 0),
        mediaTemperature_C: round(readF32(buf, 16), 1),
        differentialTemperature_C: round(readF32(buf, 20), 1),
    };
}

/**
 * Decode MediaTemperatureInfo (obj 93 / sub 300).
 *
 * @param {Buffer} payload - object payload
 * @returns {object} media / pcb / controlbox temperatures
 */
function decodeTemperature(payload) {
    const buf = Buffer.from(payload);
    return {
        mediaTemperature_C: round(readF32(buf, 0), 1),
        pcbTemperature_C: round(readF32(buf, 4), 1),
        controlBoxTemperature_C: round(readF32(buf, 8), 1),
    };
}

module.exports = {
    readF32,
    decodeMotorState,
    decodeFlowPressure,
    decodeTemperature,
};
