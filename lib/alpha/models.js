"use strict";

/*
 * Model registry for Grundfos ALPHA pumps.
 *
 * Verified against the official GENI profiles (family 52) and
 * demo_product_configuration.json in the Grundfos GO app:
 *
 *   52/1  ALPHA 3            flow object sub 289 (basic, type 304)
 *   52/6  ALPHA2 GO          flow object sub 290 (extended, type 565)
 *   52/7  ALPHA 15 / HWR /   flow object sub 290 (extended, type 565)
 *         HWR-D / COMFORT
 *   52/20 ALPHA2 GO replicate  \
 *   52/21 ALPHA2 GO Trade      | all sub 290 (extended)
 *   52/27 ALPHA 26            /
 *
 * All family-52 pumps expose motor state (obj 87 / sub 69) and media
 * temperature (obj 93 / sub 300). They differ only in the flow object.
 *
 * Connection notes:
 *   - HWR (and other type-7 variants) need no BLE bonding, but require the
 *     app-level GENI auth handshake before control works.
 *   - Alpha2 GO / Alpha3 require an encrypted BLE link (the ESPHome reference
 *     forces link encryption on connect). This is the fragile part on
 *     noble/BlueZ and may need the ESP32 transport as a fallback.
 */

const { TELEMETRY } = require("./protocol/geni");

/**
 * @typedef {object} ModelDef
 * @property {string} id config key
 * @property {string} name human-readable product name
 * @property {number} family GENI family (always 52 here)
 * @property {number} type GENI type
 * @property {{objId:number, subId:number}} flowObject which flow telemetry object to poll
 * @property {boolean} extendedFlow true if flow object carries pre-converted m3/h + head_m
 * @property {boolean} requiresAuthHandshake send the GENI auth burst after connect
 * @property {boolean} requiresBleEncryption request an encrypted BLE link on connect
 * @property {boolean} supportsControl control (mode/setpoint/start-stop) is meaningful
 */

const MODELS = {
    alpha3: {
        id: "alpha3",
        name: "ALPHA 3",
        family: 52,
        type: 1,
        flowObject: TELEMETRY.FLOW_PRESSURE_BASIC,
        extendedFlow: false,
        requiresAuthHandshake: false,
        requiresBleEncryption: true,
        supportsControl: false,
    },
    alpha2go: {
        id: "alpha2go",
        name: "ALPHA2 GO",
        family: 52,
        type: 6,
        flowObject: TELEMETRY.FLOW_PRESSURE_EXT,
        extendedFlow: true,
        requiresAuthHandshake: false,
        requiresBleEncryption: true,
        supportsControl: false,
    },
    hwr: {
        id: "hwr",
        name: "ALPHA HWR / 15 / Comfort",
        family: 52,
        type: 7,
        flowObject: TELEMETRY.FLOW_PRESSURE_EXT,
        extendedFlow: true,
        requiresAuthHandshake: true,
        requiresBleEncryption: false,
        supportsControl: true,
    },
};

/**
 * Resolve a model definition by config id, defaulting to HWR.
 *
 * @param {string} id - model id
 * @returns {ModelDef}
 */
function getModel(id) {
    return MODELS[id] || MODELS.hwr;
}

module.exports = { MODELS, getModel };
