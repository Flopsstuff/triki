# triki-controller

A dependency-free, strongly-typed **Web Bluetooth** client for the [Żabka **Triki**](https://github.com/Flopsstuff/triki)
BLE token (an nRF52810 BLE SoC + LSM6DSL accelerometer/gyroscope, shaped like a bottle cap).
It connects over the Nordic UART Service, starts the IMU stream, parses the 14-byte motion
frames, and optionally fuses orientation with a selectable 6-axis filter — **Madgwick** or
**VQF** — so you can reuse the token as a motion controller from any web app.

![Triki motion controller demo](https://flopsstuff.github.io/triki/img/controller-demo.gif)

## Browser support

Web Bluetooth is required:

- ✅ Desktop **Chrome / Edge / Opera** (Chromium-based).
- ❌ **Safari and Firefox** do not implement Web Bluetooth.
- Must run in a **secure context** — `https://` or `http://localhost`. **Not** `file://`.
- `connect()` must be called from a **user gesture** (e.g. a click handler).
- One BLE central connects at a time.

## Install

```sh
npm install triki-controller
```

## Quick start

```ts
import { TrikiController } from "triki-controller";

if (!TrikiController.isSupported()) {
  throw new Error("This browser has no Web Bluetooth.");
}

const triki = new TrikiController({ fusion: true, rateHz: 104 });

triki.on("connectionchange", (state) => {
  console.log("state:", state); // "disconnected" | "pairing" | "streaming"
});

triki.on("frame", (f) => {
  // f.gyro = { x, y, z } in deg/s, f.accel = { x, y, z } in g, f.t = ms
});

triki.on("orientation", (o) => {
  // o.quaternion = [w, x, y, z] (right-handed), o.euler = { roll, pitch, yaw } in degrees
});

triki.on("rate", (hz) => {
  console.log("streaming", hz, "Hz");
});

// Must be inside a click/tap handler:
document.querySelector("#connect")!.addEventListener("click", async () => {
  await triki.connect();
  await triki.setLed(true);     // green LED on
  await triki.setRate(208);     // bump the sample rate (26 / 52 / 104 / 208 / 416 Hz)
  triki.resetHeading();         // re-zero yaw whenever you like
});
```

Pick the filter with `fusion`: `"madgwick"` (default), `"vqf"`, `"accel"` (accelerometer-only
tilt — instant but jittery, no yaw), or `"none"` (`true`≡madgwick, `false`≡none). Raw frames
only: `{ fusion: "none" }`, listen to `"frame"`. Switch live with `setFusion(...)`. The
`MadgwickAHRS`, `VqfAHRS`, `AccelAHRS` and `FrameParser` classes are also exported and usable
standalone (the filters share an `OrientationFilter` interface).

## API

`new TrikiController(options?)` — `options`: `fusion?` (`"madgwick"`/`"vqf"`/`"accel"`/`"none"`,
default `"madgwick"`), `rateHz?` (default `104`), `beta?` (Madgwick gain, default `0.08`),
`tauAcc?` (VQF accel low-pass seconds, default `2.0`), `gyroScale?` (default `14.286`),
`gyroBias?` / `accelBias?` (per-axis correction vectors, default zeros).

| Member | Description |
| --- | --- |
| `static isSupported()` | `true` when `navigator.bluetooth` exists (SSR-safe). |
| `connect()` | Show the picker, connect, start streaming. User gesture required. |
| `reconnect()` | Reconnect to the last paired device without the picker. |
| `disconnect()` | Disconnect. |
| `setLed(on)` | Green LED on/off (throws if the token has no LED characteristic). |
| `setRate(hz)` | Set sample rate; applied live when streaming. |
| `resetHeading()` | Re-zero yaw (no-op when fusion is off). |
| `setFusion(algo)` | Switch filter at runtime (`"madgwick"`/`"vqf"`/`"accel"`/`"none"`). |
| `setBeta(v)` / `setTauAcc(v)` | Tune the active Madgwick / VQF filter live. |
| `setGyroScale(scale)` | Runtime gyro calibration. |
| `setGyroBias(v)` / `setAccelBias(v)` | Set the per-axis correction vectors live. |
| `isConnected` / `state` / `rateHz` / `hasLed` / `battery` / `fusion` / `fusionAlgorithm` | Getters. |
| `on(type, cb)` / `once` / `off` | Typed subscription; `on`/`once` return an unsubscribe fn. |

Events: `frame`, `orientation` (fusion only), `connectionchange` (payload is the state string),
`rate` (measured Hz), `battery` (level in percent, 0–100).

## Caveats

- **Yaw drift.** Fusion is 6-axis (gyro + accel, no magnetometer), so absolute heading drifts
  over time. Roll/pitch stay levelled by gravity. Call `resetHeading()` to re-zero yaw.
- **Math vs display frame.** This library emits the **right-handed** math quaternion. The Triki
  demo page negates `y` and `z` (`[w, x, -y, -z]`) only for its on-screen roll/pitch/yaw readout
  (the 3D model is driven from the unmodified quaternion) — apply that negation yourself only if
  you mirror that readout; don't double-negate.
- **Throughput.** Above ~208 Hz, BLE may not keep up; the `rate` event reports the actual
  measured throughput so you can react.

## License

MIT © Flopsstuff
