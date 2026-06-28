# Overview

Notes and tooling for the **Żabka Triki** (a.k.a. *Tiki*) — a collectible BLE token
shaped like a bottle cap (crown cap), built around an **nRF52810** BLE SoC and an
**LSM6DSL** accelerometer/gyroscope.

> Goal: read the token's motion sensors over BLE and reuse it as a **motion
> controller** — recover orientation from gyro + accel fusion.

<div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
  <figure style="margin:0; max-width:320px;">
    <img src="/img/front.jpg" alt="Triki front" />
    <figcaption>Front — Triki logo</figcaption>
  </figure>
  <figure style="margin:0; max-width:320px;">
    <img src="/img/board.jpg" alt="Triki board" />
    <figcaption>Board — Żabka "Z" logo, nRF52810</figcaption>
  </figure>
  <figure style="margin:0; max-width:240px;">
    <video src="/img/demo.mp4" controls muted loop autoplay playsinline preload="metadata" style="width:100%; border-radius:8px; display:block;"></video>
    <figcaption>Live demo — streaming motion over BLE</figcaption>
  </figure>
</div>

## Repository layout

```
assets/      device photos (tracked)
docs/        this VitePress documentation site (tracked)
tools/       BLE tooling + scripts (tracked; .venv ignored)
```

## At a glance

- **[Hardware](./hardware):** nRF52810 (Cortex-M4 BLE SoC) + LSM6DSL IMU + Macronix
  MX25R8035F SPI NOR.
- **[BLE protocol](./ble-protocol):** request/response over the Nordic UART Service —
  a 1-bit green-LED control register plus a command interface.
- **[IMU streaming](./imu-streaming):** live accelerometer + gyroscope
  over BLE, decoded and verified at ~104 Hz.
- **[Web Bluetooth controller](./controller):** an in-browser orientation visualizer.

## Status

- [x] Captured the GATT map; the protocol is NUS request/response
- [x] **Live accel + gyro streaming over BLE** — 8-byte start command,
      14-byte frames, decoded and verified (`tools/ble_imu_stream.py`).
      See [IMU streaming](./imu-streaming).
- [x] In-browser [Web Bluetooth controller](./controller) with a live 3D orientation model
- [x] Extracted the IMU-parse + Madgwick orientation core into a reusable,
      dependency-free [`triki-controller`](https://www.npmjs.com/package/triki-controller)
      library (browser BLE client + framework-agnostic fusion math)
- [ ] Build a native controller bridge (joystick / OSC / HID) — the parse + fusion
      half above is done and reusable; what's left is a native BLE transport and the
      OS-level output, since a browser can't emit a real joystick / HID
      (see [Web Bluetooth controller](./controller))
