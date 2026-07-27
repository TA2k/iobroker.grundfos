![Logo](admin/grundfos.png)

# ioBroker.grundfos

[![NPM version](https://img.shields.io/npm/v/iobroker.grundfos.svg)](https://www.npmjs.com/package/iobroker.grundfos)
[![Downloads](https://img.shields.io/npm/dm/iobroker.grundfos.svg)](https://www.npmjs.com/package/iobroker.grundfos)
![Number of Installations](https://iobroker.live/badges/grundfos-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/grundfos-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.grundfos.png?downloads=true)](https://nodei.co/npm/iobroker.grundfos/)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.grundfos/workflows/Test%20and%20Release/badge.svg)

## grundfos adapter for ioBroker

Reads and controls Grundfos ALPHA pumps (ALPHA2 GO, ALPHA3, ALPHA HWR / 15 / Comfort)
over Bluetooth Low Energy using the GENI protocol.

### Disclaimer

Grundfos and ALPHA are trademarks of Grundfos Holding A/S. This is an unofficial,
community-built adapter and is not affiliated with or endorsed by Grundfos. Use at your
own risk.

### Requirements

- ioBroker host with a working Bluetooth Low Energy stack (e.g. a Raspberry Pi with
  BlueZ) for the two direct BLE paths. The BLE driver (`@stoprocent/noble`) is an
  optional dependency; if it is missing, only the ESPHome path works.
- Node.js 20 or newer.

### Transports

Configure one entry per pump in the adapter settings and pick the transport that matches
your setup:

1. **AlphaReader MI401 (passive)** — listens to the BLE advertising broadcast by the
   plug-on AlphaReader dongle. No pairing, read-only, a small set of values (flow, head,
   temperature, mode). Activate the reader mode on the pump by long-pressing the right
   button. Most robust option.
2. **Direct BLE (GENI)** — connects to the pump's GENI service and polls telemetry, and
   for the HWR family also controls mode/setpoint/start-stop. ALPHA2 GO / ALPHA3 expect
   an **encrypted BLE link**; that may require pairing the pump at the OS/BlueZ level
   first, which `noble` cannot always initiate on its own. If this path is unreliable on
   your hardware, use the ESPHome path instead.
3. **ESP32 (ESPHome API)** — an ESP32 running the ESPHome `alpha3` / `alpha_hwr`
   component does the BLE work and exposes the pump as ESPHome entities; the adapter
   connects to its native API. Set host, port (default 6053), and password or encryption
   key. Most reliable path for direct pump access.

### Control

Control states (`<pump>.control.mode`, `.setpoint`, `.running`) are only created for
models and transports that support writing (currently the HWR family over the direct BLE
path). The setpoint unit depends on the mode: meters for pressure modes, rpm for constant
speed, m³/h for constant flow.

### Configuration

Add one row per pump in the **Devices** table in the adapter settings. The columns:

| Column | Meaning |
| --- | --- |
| **Name** | Free label; also becomes the object id (`grundfos.<instance>.<name>`). |
| **Transport** | How the adapter reaches the pump: `advertising`, `gatt`, or `esphome` (see above). |
| **Model** | `hwr` (ALPHA HWR / 15 / Comfort), `alpha2go` (ALPHA2 GO), or `alpha3` (ALPHA 3). Determines which telemetry object is polled and whether control is available. |
| **Address** | BLE MAC address for `advertising` / `gatt` (e.g. `aa:bb:cc:dd:ee:ff`), or the ESP32 host/IP for `esphome`. For `advertising` it may be left empty to accept any AlphaReader in range. |
| **Poll (ms)** | Telemetry poll interval for the `gatt` transport. |
| **ESP Port / ESP Password / ESP Encryption Key** | **Only relevant when Transport is `esphome`.** Port defaults to `6053`; set the password or the encryption (Noise) key configured in your ESPHome node. Leave these empty for the `advertising` and `gatt` transports. |

Note: the settings table always shows all columns. It cannot hide the ESP-only columns
based on the selected transport (per-row conditional visibility is not supported inside a
table), so just leave the ESP fields empty unless you use the `esphome` transport.

### Debugging

Set the adapter log level to `debug` to see the full, untruncated protocol traffic (raw
hex frames in both directions, reassembly, decoded values, the auth handshake, and raw
advertising packets). This is intended for verifying behaviour against real hardware.

### Standalone library

The protocol and transport code lives in `lib/alpha/` and has no ioBroker dependency, so
it can be reused in other Node.js projects:

```js
const { AlphaClient, ControlMode } = require("./lib/alpha");

const client = new AlphaClient({ transport: "gatt", model: "hwr", address: "aa:bb:cc:dd:ee:ff" });
client.on("telemetry", (t) => console.log(t));
await client.start();
```

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (TA2k) initial release

## License

MIT License

Copyright (c) 2026 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
