"use strict";

/*
 * Public API of the standalone Grundfos ALPHA library.
 *
 * This module has no ioBroker dependency and can be copy-pasted into other
 * projects. Provide any logger with debug/info/warn/error (or none for a
 * console default).
 *
 * Example:
 *   const { AlphaClient, ControlMode } = require("./lib/alpha");
 *   const client = new AlphaClient({ transport: "gatt", model: "hwr", address: "aa:bb:.." });
 *   client.on("telemetry", (t) => console.log(t));
 *   await client.start();
 */

const { AlphaClient } = require("./AlphaClient");
const { MODELS, getModel } = require("./models");
const geni = require("./protocol/geni");
const crc = require("./protocol/crc");
const frame = require("./protocol/frame");
const telemetry = require("./protocol/telemetry");
const advertising = require("./protocol/advertising");

module.exports = {
    AlphaClient,
    MODELS,
    getModel,
    ControlMode: geni.ControlMode,
    CONTROL_MODE_NAMES: geni.CONTROL_MODE_NAMES,
    UUID: geni.UUID,
    // Protocol codec, exposed for reuse/testing.
    protocol: { crc, frame, geni, telemetry, advertising },
};
