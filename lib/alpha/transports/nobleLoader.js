"use strict";

/*
 * Optional noble loader. noble is an optionalDependency so the adapter can run
 * with only the ESPHome transport on systems without a BLE stack. We try the
 * actively-maintained @stoprocent/noble first, then @abandonware/noble.
 *
 * Two things learned from ioBroker.ble:
 *   - NOBLE_HCI_DEVICE_ID must be set BEFORE noble is required, so the correct
 *     HCI adapter is selected. We therefore load lazily and only once.
 *   - Newer @stoprocent/noble may export a factory function instead of a ready
 *     instance (see stoprocent/noble commit b67eea24); if the default export
 *     has no `.on`, call it to obtain the instance.
 */

let cached;

/**
 * Load a noble implementation, or return null if none is installed.
 *
 * @param {object} log - logger for diagnostics
 * @param {number} [hciDevice] - HCI adapter index (Linux); sets NOBLE_HCI_DEVICE_ID
 * @returns {object|null} noble instance or null
 */
function loadNoble(log, hciDevice) {
    if (cached !== undefined) {
        return cached;
    }
    // Must be set before requiring noble so it binds to the right HCI adapter.
    if (hciDevice != null && process.env.NOBLE_HCI_DEVICE_ID == null) {
        process.env.NOBLE_HCI_DEVICE_ID = String(hciDevice);
    }
    for (const name of ["@stoprocent/noble", "@abandonware/noble"]) {
        try {
            // eslint-disable-next-line global-require
            let mod = require(name);
            // @stoprocent/noble may export a factory rather than an instance.
            if (mod && typeof mod.on !== "function" && typeof mod === "function") {
                mod = mod({ extended: false });
            }
            cached = mod;
            if (log) {
                log.debug(`BLE: using ${name}`);
            }
            return cached;
        } catch (e) {
            if (log) {
                log.debug(`BLE: ${name} not available: ${e.message}`);
            }
        }
    }
    cached = null;
    if (log) {
        log.warn(
            "BLE library (noble) not available - the AlphaReader (advertising) and direct BLE (gatt) " +
                "transports are disabled. The ESPHome transport still works. " +
                "noble is an optional dependency that failed to build, usually because system packages are missing. " +
                "On Debian/Ubuntu/Raspberry Pi OS install them with:\n" +
                "    sudo apt-get install -y build-essential coreutils bluetooth bluez libbluetooth-dev libudev-dev libcap2-bin\n" +
                "then reinstall the adapter so the optional dependency is rebuilt:\n" +
                "    iobroker upgrade grundfos --install\n" +
                "(or use 'Rebuild' / reinstall in the ioBroker admin), and restart the adapter.",
        );
    }
    return cached;
}

module.exports = { loadNoble };
