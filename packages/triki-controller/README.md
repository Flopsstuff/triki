# triki-controller

A dependency-free, strongly-typed **Web Bluetooth** client for the [Żabka **Triki**](https://github.com/Flopsstuff/triki)
BLE token (an nRF52810 BLE SoC + LSM6DSL accelerometer/gyroscope, shaped like a bottle cap).
It connects over the Nordic UART Service, starts the IMU stream, parses the 14-byte motion
frames, and optionally fuses orientation with a 6-axis **Madgwick** filter — so you can reuse
the token as a motion controller from any web app.

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

Raw frames without fusion: construct with `{ fusion: false }` and listen only to `"frame"`.
The `MadgwickAHRS` and `FrameParser` classes are also exported and usable standalone.

## API

`new TrikiController(options?)` — `options`: `fusion?` (default `true`), `rateHz?` (default `104`),
`beta?` (default `0.08`), `gyroScale?` (default `14.286`).

| Member | Description |
| --- | --- |
| `static isSupported()` | `true` when `navigator.bluetooth` exists (SSR-safe). |
| `connect()` | Show the picker, connect, start streaming. User gesture required. |
| `reconnect()` | Reconnect to the last paired device without the picker. |
| `disconnect()` | Disconnect. |
| `setLed(on)` | Green LED on/off (throws if the token has no LED characteristic). |
| `setRate(hz)` | Set sample rate; applied live when streaming. |
| `resetHeading()` | Re-zero yaw (no-op when fusion is off). |
| `setGyroScale(scale)` | Runtime gyro calibration. |
| `isConnected` / `state` / `rateHz` / `hasLed` / `fusion` | Getters. |
| `on(type, cb)` / `once` / `off` | Typed subscription; `on`/`once` return an unsubscribe fn. |

Events: `frame`, `orientation` (fusion only), `connectionchange` (payload is the state string),
`rate` (payload is the measured Hz).

## Caveats

- **Yaw drift.** Fusion is 6-axis (gyro + accel, no magnetometer), so absolute heading drifts
  over time. Roll/pitch stay levelled by gravity. Call `resetHeading()` to re-zero yaw.
- **Math vs display frame.** This library emits the **right-handed** math quaternion. The Triki
  demo page negates `y` and `z` (`[w, x, -y, -z]`) purely for its left-handed CSS 3D cube — apply
  that negation yourself if you mirror that display; don't double-negate.
- **Throughput.** Above ~208 Hz, BLE may not keep up; the `rate` event reports the actual
  measured throughput so you can react.

## License

MIT © Flopsstuff
