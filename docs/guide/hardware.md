# Hardware

| Component | Part | Role |
|---|---|---|
| MCU | **nRF52810-QCxx** (QFN, marking `N52810 QDAAE0`) | BLE SoC, Cortex-M4 |
| IMU | **LSM6DSL** | 3-axis accel + gyro (motion input) |
| External flash | **Macronix MX25R8035F** (SPI NOR, 8 Mbit / 1 MB) | external storage |
| Clock | 32.000 MHz crystal | |
| Other | BLE antenna, LED, button | |

<figure style="margin:1rem 0; max-width:480px;">
  <img src="/img/board.jpg" alt="Triki board — nRF52810" />
  <figcaption>Board — Żabka "Z" logo, nRF52810</figcaption>
</figure>

The **LSM6DSL** accelerometer/gyroscope is the part this project cares about — see
[IMU streaming](./imu-streaming) for reading it live over BLE.
