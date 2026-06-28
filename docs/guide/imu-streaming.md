# IMU streaming

The Triki streams raw accelerometer + gyroscope over BLE once you send a multi-byte
start command on RX. **Verified live here.**

## Start the stream

Write to RX `…0002`:

```
20 10 00 D0 07 68 00 03
```

(`68 00` = 104 → ~104 Hz sample rate.)

## Stream format

The device then pushes 14-byte frames on TX `…0003`:

```
offset  0    2     4     6      8      10     12
        22 00 gyroX gyroY gyroZ accelX accelY accelZ
header ─┘     └──────────────── 6 × int16 LE ──────┘
```

Bytes 0–1 are the `22 00` header; the six axes follow as signed int16,
little-endian at offsets 2 / 4 / 6 (gyro) and 8 / 10 / 12 (accel). Scales:

- **gyro / 14.286** → deg/s — LSM6DSL ±2000 dps (70 mdps/LSB). The older `131.0`
  was an MPU-6050 ±250 dps value carried over from notes; it under-rotated ~9×.
- **accel / 2048.0** → g — LSM6DSL ±16 g (flat token reads +2048 = 1 g).

Frames arrive in bursts at ~104 Hz (the default; the rate is selectable — see
[Sample rate](./ble-protocol#sample-rate-odr)).

### Startup behaviour

- The **first ~20 frames after start are noise** — discard them before trusting the
  data (to be verified).
- For a clean gravity/zero baseline, let the token sit **flat and still** for a moment
  before sending the start command.
- There is no stop opcode: the stream ends when you disconnect.

## Verification

Under shaking, gyro swings ±10000+, and the accel axis aligned with gravity reads
≈ +2048 (= 1 g) — decode confirmed at ~104 Hz. Reader: `tools/ble_imu_stream.py`
(see [Tooling](./tooling)).

This is sufficient to use the token as a **motion controller** — recover orientation
via gyro + accel fusion (e.g. Madgwick AHRS).

> Note: the single-byte opcodes (`0x05` / `0x07` / `0x09` / …) are a separate
> diagnostic/management interface — raw IMU is NOT there; it only comes from the
> start-stream command above.
