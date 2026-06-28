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
22 00 | gyroX gyroY gyroZ | accelX accelY accelZ
```

Each axis is a signed int16, little-endian. Scales:

- **gyro / 14.286** → deg/s — LSM6DSL ±2000 dps (70 mdps/LSB). The older `131.0`
  was an MPU-6050 ±250 dps value carried over from notes; it under-rotated ~9×.
- **accel / 2048.0** → g — LSM6DSL ±16 g (flat token reads +2048 = 1 g).

Frames arrive in bursts at ~104 Hz (the default; the rate is selectable — see
[Sample rate](./ble-protocol#sample-rate-odr)).

## Verification

Under shaking, gyro swings ±10000+, and the accel axis aligned with gravity reads
≈ +2048 (= 1 g) — decode confirmed at ~104 Hz. Reader: `tools/ble_imu_stream.py`
(see [Tooling](./tooling)).

This is sufficient to use the token as a **motion controller** — recover orientation
via gyro + accel fusion (e.g. Madgwick AHRS).

> Note: the single-byte opcodes (`0x05` / `0x07` / `0x09` / …) are a separate
> diagnostic/management interface — raw IMU is NOT there; it only comes from the
> start-stream command above.
