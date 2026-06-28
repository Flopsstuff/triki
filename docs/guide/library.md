# triki-controller (npm package)

[![npm](https://img.shields.io/npm/v/triki-controller.svg)](https://www.npmjs.com/package/triki-controller)

`triki-controller` is the reusable core of the [Web Bluetooth controller](./controller)
shipped as a dependency-free, strongly-typed **TypeScript** package. It connects to the
Triki token over the Nordic UART Service, starts the IMU stream, parses the 14-byte
[motion frames](./imu-streaming), and (optionally) fuses orientation with a selectable
6-axis filter — **Madgwick** or **VQF** — so any web app can reuse the token as a motion
controller.

- **npm:** [`triki-controller`](https://www.npmjs.com/package/triki-controller)
- **Source + README:** [`packages/triki-controller`](https://github.com/Flopsstuff/triki/tree/main/packages/triki-controller#readme)
- ESM-only, ships its own `.d.ts`. The browser core has **zero runtime dependencies**;
  the optional Node transport uses `@abandonware/noble` (see
  [Node.js](#nodejs-receive-outside-the-browser)).

The visualizer page and this package share the same parsing and fusion math; the
[BLE protocol](./ble-protocol) and [IMU streaming](./imu-streaming) pages are the
authoritative spec.

## Install

```sh
npm install triki-controller
```

## Browser support

`TrikiController` uses the **Web Bluetooth API**, so the same constraints as the
[live controller](./controller#browser-support) apply:

- Desktop **Chrome / Edge / Opera** (Chromium). **Safari and Firefox** do not implement
  Web Bluetooth.
- A **secure context** is required: `https://` or `http://localhost`, never `file://`.
- `connect()` must run inside a **user gesture** (e.g. a click handler).
- Only one BLE central holds the token at a time.

`TrikiController.isSupported()` returns `false` (rather than throwing) wherever Web
Bluetooth is missing, so it is safe to call during SSR.

## Quick start

```ts
import { TrikiController } from "triki-controller";

if (!TrikiController.isSupported()) {
  throw new Error("This browser has no Web Bluetooth.");
}

const triki = new TrikiController({ fusion: true, rateHz: 104 });

triki.on("connectionchange", (state) => {
  // "disconnected" | "pairing" | "streaming"
  console.log("state:", state);
});

triki.on("frame", (f) => {
  // f.gyro = { x, y, z } in deg/s, f.accel = { x, y, z } in g, f.t = ms
});

triki.on("orientation", (o) => {
  // o.quaternion = [w, x, y, z] (right-handed), o.euler = { roll, pitch, yaw } in degrees
});

triki.on("rate", (hz) => console.log("streaming", hz, "Hz"));

// Must be inside a click/tap handler:
document.querySelector("#connect")!.addEventListener("click", async () => {
  await triki.connect();      // shows the device picker, starts streaming
  await triki.setLed(true);   // green LED on
  await triki.setRate(208);   // 26 / 52 / 104 / 208 / 416 Hz
  triki.resetHeading();       // re-zero yaw whenever you like
});
```

Pick the filter with the `fusion` option — `"madgwick"` (default), `"vqf"`, `"accel"`
(accelerometer-only tilt: instant but jittery, no yaw), or `"none"` (`true` ≡
`"madgwick"`, `false` ≡ `"none"`). For raw frames only, use `{ fusion: "none" }` (or
`false`) and listen to `"frame"`; the `orientation` event is then never emitted. You can
also switch at runtime with `setFusion(...)`.

## Events

`TrikiController` is a typed emitter. `on(type, cb)` and `once(type, cb)` return an
unsubscribe function; `off(type, cb)` removes a listener.

| Event | Payload | When |
|---|---|---|
| `frame` | `FrameEvent` | every decoded motion frame |
| `orientation` | `OrientationEvent` | every frame, **fusion only** |
| `connectionchange` | `ConnectionState` (string) | state transitions |
| `rate` | `number` (Hz) | ~once per second, measured throughput |
| `battery` | `number` (0–100) | on connect, then on each battery update |

```ts
interface FrameEvent {
  raw:   { gx: number; gy: number; gz: number; ax: number; ay: number; az: number }; // int16 counts
  gyro:  { x: number; y: number; z: number };  // deg/s
  accel: { x: number; y: number; z: number };  // g
  t: number;                                    // performance.now() ms
}

interface OrientationEvent {
  quaternion: readonly [w: number, x: number, y: number, z: number]; // right-handed
  euler: { roll: number; pitch: number; yaw: number };               // degrees
  algorithm: "madgwick" | "vqf" | "accel" | "none";                  // active filter
  t: number;
}
```

## API

`new TrikiController(options?)`:

| Option | Default | Meaning |
|---|---|---|
| `fusion` | `true` | filter: `"madgwick"`/`"vqf"`/`"accel"`/`"none"` (`true`≡madgwick, `false`≡none) |
| `rateHz` | `104` | initial IMU sample rate |
| `beta` | `0.08` | Madgwick filter gain |
| `tauAcc` | `2.0` | VQF accel low-pass time constant (seconds) |
| `gyroScale` | `14.286` | gyro scale in LSB per deg/s (LSM6DSL ±2000 dps) |
| `gyroBias` | `{0,0,0}` | per-axis gyro correction (deg/s) subtracted from every sample |
| `accelBias` | `{0,0,0}` | per-axis accel correction (g) subtracted from every sample |
| `transport` | Web Bluetooth | BLE transport; pass a `NobleTransport` (Node) or any `TrikiTransport` |

| Member | Description |
|---|---|
| `static isSupported()` | `true` when `navigator.bluetooth` exists (SSR-safe). |
| `connect()` | Show the picker, connect, start streaming. User gesture required. |
| `reconnect()` | Reconnect to the last paired device without the picker. |
| `disconnect()` | Disconnect. |
| `setLed(on)` | Green LED on/off (throws if the token has no LED characteristic). |
| `setRate(hz)` | Set the sample rate; applied live when streaming. |
| `resetHeading()` | Re-zero yaw (no-op when fusion is off). |
| `setFusion(algo)` | Switch filter at runtime (`"madgwick"`/`"vqf"`/`"accel"`/`"none"`); re-zeros heading. |
| `setBeta(v)` | Set Madgwick gain; applied live when Madgwick is active. |
| `setTauAcc(v)` | Set VQF accel low-pass (seconds); applied live when VQF is active. |
| `setGyroScale(scale)` | Runtime gyro calibration. |
| `setGyroBias(v)` / `setAccelBias(v)` | Set the per-axis correction vectors live. |
| `isConnected` / `state` / `rateHz` / `hasLed` / `battery` / `fusion` / `fusionAlgorithm` | Getters. |

`connect()` rejects (after cleaning up) if pairing or the handshake fails, so wrap it in
`try/catch` to surface picker errors. `reconnect()` reuses the cached device and throws
if `connect()` was never called.

## Node.js (receive outside the browser)

Web Bluetooth only exists in the browser. To receive the token from a plain Node
process, pass a **`NobleTransport`** — a transport backed by
[`@abandonware/noble`](https://github.com/abandonware/noble) — from the
`triki-controller/node` entry point. Everything else (events, fusion, `setLed`,
`setRate`, `resetHeading`) behaves exactly as in the browser.

```sh
npm install triki-controller @abandonware/noble
```

```ts
import { TrikiController, NobleTransport } from "triki-controller/node";

const triki = new TrikiController({ transport: new NobleTransport() });

triki.on("orientation", (o) => console.log(o.euler)); // { roll, pitch, yaw }
await triki.connect(); // scans for a "TRIKI" token, connects, starts streaming
```

A runnable demo lives at
[`packages/triki-controller/example/node.mjs`](https://github.com/Flopsstuff/triki/blob/main/packages/triki-controller/example/node.mjs).

`@abandonware/noble` is an **optional peer dependency**: install it alongside
`triki-controller` (as above). It is imported lazily, only when `connect()` runs, so
`triki-controller` never pulls the native module on its own. On macOS the first run
prompts the terminal (or your IDE) for Bluetooth access.

**`new NobleTransport(options?)`:**

| Option | Default | Meaning |
|---|---|---|
| `namePrefix` | `"TRIKI"` | match devices whose advertised name starts with this prefix |
| `address` | — | match a specific BLE address instead of by name |
| `noble` | `@abandonware/noble` | a noble-API-compatible module to use instead |

::: warning Native build
`@abandonware/noble` compiles a native addon, and its bundled `node-gyp` is old enough
to fail on the newest Node releases. Use a current **Node LTS** (which has prebuilt
binaries), or pass a drop-in fork through the `noble` option:

```ts
import noble from "@stoprocent/noble";
const triki = new TrikiController({ transport: new NobleTransport({ noble }) });
```
:::

### Custom transports

`NobleTransport` and the browser `WebBluetoothTransport` both implement the small
**`TrikiTransport`** interface (`connect`, `writeRx`, `writeCtrl`, `onFrame`,
`onDisconnect`, `disconnect`, `hasLed`). Implement it yourself to drive the controller
over any link — a WebSocket bridge, a serial dongle, or a replay of recorded frames —
while reusing all of the parsing and fusion. The transport is a dumb NUS pipe; the
controller owns the Triki protocol, so the protocol logic lives in exactly one place.

## Standalone primitives

The parsing, fusion and protocol code is pure and **environment-agnostic** (no DOM, no
Bluetooth), so it works in Node or a worker. This is the seam for a non-browser
transport, for example a native bridge that owns its own BLE stack and only reuses the
math.

```ts
import { FrameParser, MadgwickAHRS, startCmd, decodeCounts } from "triki-controller";

const parser = new FrameParser();
const madgwick = new MadgwickAHRS({ beta: 0.08 });

// Feed your own BLE notification bytes (from any transport):
for (const f of parser.push(notificationBytes)) {
  const gx = f.gxRaw / 14.286, gy = f.gyRaw / 14.286, gz = f.gzRaw / 14.286; // deg/s
  const ax = f.axRaw / 2048, ay = f.ayRaw / 2048, az = f.azRaw / 2048;       // g
  madgwick.update(gx, gy, gz, ax, ay, az, 1 / 104);
}
console.log(madgwick.euler()); // { roll, pitch, yaw } in degrees

// startCmd(hz) builds the 8-byte START payload to write to RX:
await rxCharacteristic.writeValue(startCmd(208));
```

Exported alongside the controller:

- `MadgwickAHRS` — 6-axis filter: `update(gx, gy, gz, ax, ay, az, dt)`, `quaternion()`,
  `euler()`, `reset()`.
- `VqfAHRS` — 6-axis VQF filter (gyro strapdown + low-pass-filtered accel inclination;
  ported from [VQF](https://github.com/dlaidig/vqf) by Daniel Laidig, MIT). Drop-in for
  `MadgwickAHRS` — same `update / quaternion / reset` shape and `[w, x, y, z]` convention,
  plus `setTauAcc(tau)`.
- `AccelAHRS` — accelerometer-only tilt (no gyro, no yaw); same drop-in shape and frame.
- `OrientationFilter` — the common interface all three filters implement, so you can swap them.
- `FrameParser` — stateful framer with header resync: `push(chunk) => RawFrame[]`,
  `reset()`. `decodeCounts(frame)` decodes a single 14-byte frame.
- `startCmd(hz)` / `ledCmd(on)` — command builders.
- Quaternion helpers `quatMul` / `quatAboutZ` / `yawRadOf` / `eulerOf`.
- Constants: `NUS_SERVICE` / `NUS_RX` / `NUS_TX` / `NUS_CTRL`, `START_BASE`,
  `FRAME_LEN`, `SUPPORTED_RATES_HZ` (`[26, 52, 104, 208, 416]`), `DEFAULT_RATE_HZ`,
  `DEFAULT_GYRO_SCALE`, `DEFAULT_ACCEL_SCALE`, `DEFAULT_BETA`, `DEFAULT_TAU_ACC`.

## Caveats

- **Yaw drift.** Fusion is 6-axis (gyro + accel, no magnetometer), so absolute heading
  drifts over time — for **both** Madgwick and VQF. Roll/pitch stay levelled by gravity.
  Call `resetHeading()` to re-zero yaw.
- **Filter choice.** All filters share the same output frame (right-handed
  `[w, x, y, z]`, gravity-up), so they are interchangeable. Madgwick exposes one gain
  (`beta`: higher = trusts the accel more, snappier but noisier); VQF exposes
  `tauAcc` (accel low-pass time constant in seconds: higher = smoother, slower tilt);
  `"accel"` is gyro-free tilt — instant roll/pitch but noisy, and yaw stays 0.
- **Math vs display frame.** The library emits the **right-handed** math quaternion. The
  visualizer page negates `y` and `z` (`[w, x, -y, -z]`) only for its on-screen
  roll/pitch/yaw readout, to match the visual sense of rotation; the 3D model itself is
  driven from the unmodified quaternion via a per-model mount offset. Apply that negation
  yourself only if you mirror that readout, and do not double-negate.
- **Throughput.** Above ~208 Hz, BLE may not keep up; the `rate` event reports the
  actual measured throughput so the app can react to the real frame rate, not the
  requested one.
- **No native joystick.** A browser cannot emit a real joystick / HID gamepad. Turning
  the orientation stream into OS-level input still needs a native helper or a
  WebSocket / WebHID side channel (see the roadmap on the [Overview](./overview#status)).

## License

MIT.
