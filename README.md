# triki — Żabka Triki BLE token

### ▶ [Live Web Bluetooth controller](https://flopsstuff.github.io/triki/controller/)

Open it in **Chrome / Edge** to stream the token's motion straight from the browser and
watch a live 3D orientation.

Notes and tooling for the **Żabka Triki** (a.k.a. *Tiki*) — a collectible BLE token
shaped like a bottle cap (crown cap), built around an **nRF52810** BLE SoC and an
**LSM6DSL** accelerometer/gyroscope. The goal of this project is to read the token's
motion sensors over BLE and reuse it as a **motion controller**.

## Demo

https://github.com/user-attachments/assets/61ef9f09-5221-43e0-a817-9f42f8408c86

> If the player doesn't load, [watch the clip directly](assets/img.mp4).

## 📖 **Docs site:** <https://flopsstuff.github.io/triki/>

| Cap | Board |
|---|---|
| ![front](assets/1.jpg) | ![board](assets/2.jpg) |
| Triki logo | Żabka "Z" logo, nRF52810 |

## Hardware

| Component | Part | Role |
|---|---|---|
| MCU | **nRF52810-QCxx** (QFN, marking `N52810 QDAAE0`) | BLE SoC, Cortex-M4 |
| IMU | **LSM6DSL** | 3-axis accel + gyro (motion input) |
| External flash | **Macronix MX25R8035F** (SPI NOR, 8 Mbit / 1 MB) | external storage |
| Clock | 32.000 MHz crystal | |
| Other | BLE antenna, LED, button | |

## Repository layout

```
assets/      device photos (tracked)
docs/        VitePress documentation site (tracked)
tools/       BLE tooling + scripts (tracked; .venv ignored)
```

## BLE interface

Advertising: name `TRIKI <serial>` / `Triki <serial>`, address
`XX:XX:XX:XX:XX:XX` (random static), service `0x0001`.

> Personal project on my own device. No device-identifying values (serial, BLE MAC)
> are published — placeholders `<serial>` / `XX:XX:XX:XX:XX:XX` are used throughout.

GATT (read with bleak on macOS):
```
Nordic UART Service  6e400001-b5a3-f393-e0a9-e50e24dcca9e
  RX   …0002  [write, write-no-response]   commands host→token
  TX   …0003  [notify]                     responses token→host
  ctrl …0004  [read, write]  = 0x00        control register (green LED)
Battery 0x180F → 0x2A19 = 0x64 (100%)
```
The token speaks a request/response protocol over NUS. The command that starts the
accelerometer/gyroscope stream and the 14-byte motion-frame format are documented in
[`docs/guide/ble-protocol.md`](docs/guide/ble-protocol.md) and
[`docs/guide/imu-streaming.md`](docs/guide/imu-streaming.md). Live decoding is verified
at ~104 Hz (`tools/ble_imu_stream.py`).

## Tooling

Details and commands in [`tools/README.md`](tools/README.md).

- **bleak 3.0.2** (venv) + scripts:
  - `tools/ble_scan.py` — BLE scanner
  - `tools/ble_dump.py` — connect and dump the GATT map
  - `tools/ble_nus.py` — interactive NUS console (write to RX, listen on TX)
  - `tools/ble_imu_stream.py` — start + decode the accel/gyro stream
- **Web Bluetooth page** — in-browser orientation visualizer, published with the docs
  site and runnable locally: see [`docs/guide/controller.md`](docs/guide/controller.md)


## Credits and contributors
 - <a href="https://github.com/Piwencjusz">Piwencjusz</a> — PCB photos, NOR dump, OpenOCD probing
 - <a href="https://github.com/moe-takasaki">tsuki</a> — Deeper dive into hw and sw RE, SEGGER/J-Link analysis
 - <a href="https://github.com/AND-Y0">AND-Y0</a> — BLE communication protocol description
