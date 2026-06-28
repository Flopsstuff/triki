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

## Axis orientation

The IMU axes were mapped empirically — holding the token still in each face-up / edge-up
pose and reading which accelerometer axis settles at ±1 g. Reference frame: look at the
**PCB face** (the green board with the **Ż** logo) held upright; **+Z** points out of the
PCB face, toward you.

![Triki IMU axes — looking at the PCB face](/img/axes.jpg)

| Axis | Points toward (PCB face up, Ż upright) |
|---|---|
| **+Z** | out of the PCB face (Ż side) |
| **−Z** | out of the cap face (metal crown / "T" logo) |
| **−Y** | top of the Ż (12 o'clock) |
| **+Y** | bottom of the Ż (6 o'clock) |
| **−X** | right of the Ż (3 o'clock) |
| **+X** | left of the Ż (9 o'clock) |

The accelerometer axes form a **right-handed** triad (X × Y = +Z), matching the LSM6DSL
convention.

Measured (token still, one axis up at a time): PCB face up → Z ≈ +1.0 g; cap face up →
Z ≈ −1.0 g; top of Ż up → Y ≈ −1.0 g; right of Ż up → X ≈ −1.0 g; left of Ż up → X ≈
+1.0 g. Per-axis magnitudes vary by a few percent (uncalibrated MEMS offset/scale).

### What the accelerometer vector means

The accelerometer measures **specific force** — the support/reaction force on the
sensor — **not** gravity directly. At rest it reads the reaction that holds the token
out of free fall, so the vector points **up, away from Earth**, with magnitude ≈ 1 g:
the axis facing the sky reads **+1 g**. The direction *toward* Earth is therefore
**−accel** while the token is still. In free fall it would read ≈ 0. During motion,
linear acceleration adds to the gravity component — which is why orientation is recovered
with a fusion filter (Madgwick) rather than by trusting raw accel as "down".

## Verification

Under shaking, gyro swings ±10000+, and the accel axis aligned with gravity reads
≈ +2048 (= 1 g) — decode confirmed at ~104 Hz. Reader: `tools/ble_imu_stream.py`
(see [Tooling](./tooling)).

This is sufficient to use the token as a **motion controller** — recover orientation
via gyro + accel fusion (e.g. Madgwick AHRS).

> Note: the single-byte opcodes (`0x05` / `0x07` / `0x09` / …) are a separate
> diagnostic/management interface — raw IMU is NOT there; it only comes from the
> start-stream command above.
