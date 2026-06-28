# Overview

Notes and tooling for the **Żabka Triki** (a.k.a. *Tiki*) — a collectible BLE token
shaped like a bottle cap (crown cap), built around an **nRF52810** BLE SoC and an
**LSM6DSL** accelerometer/gyroscope.

> Goal: read the token's motion sensors over BLE and reuse it as a **motion
> controller** — recover orientation from gyro + accel fusion. No device-identifying
> values (serial, BLE MAC) are published.

<div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
  <figure style="margin:0; max-width:320px;">
    <img src="/img/front.jpg" alt="Triki front" />
    <figcaption>Front — Triki logo</figcaption>
  </figure>
  <figure style="margin:0; max-width:320px;">
    <img src="/img/board.jpg" alt="Triki board" />
    <figcaption>Board — Żabka "Z" logo, nRF52810</figcaption>
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
- [x] In-browser [Web Bluetooth controller](./controller) with a live 3D orientation cube
- [ ] Build a native controller bridge (orientation fusion → joystick / OSC / HID)
