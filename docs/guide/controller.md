# Web Bluetooth controller (orientation visualizer)

<p><a href="../controller/" target="_blank" rel="noreferrer"><strong>▶ Open the live controller</strong></a> — runs in the browser, no install (Chromium-based browsers only).</p>

A static page (`docs/public/controller/index.html`) that connects to the Triki token
straight from the browser via the **Web Bluetooth API**, streams the IMU, and drives a
live 3D model tracking the token's orientation. No backend and no build step — it is
published with this site and also runs locally.

> The page is a thin UI over the [`triki-controller`](./library) npm package: all of the
> BLE, frame parsing and Madgwick fusion live in the package, loaded at runtime from a
> CDN (`https://esm.sh/triki-controller`). The page itself only renders the model,
> readouts and controls. (Loading from a CDN means the page needs network access on
> first load; the package is tiny and gets cached.)

> OPSEC: the page stores **no device identifiers** — the browser's device picker
> selects the token at runtime. Keep the serial / MAC / host UUID out of any tracked
> file; this doc uses `<serial>` / `XX:XX:XX:XX:XX:XX` placeholders.

## What it does

- Connects to the Nordic UART Service, subscribes to TX, sends the IMU start command.
- Decodes the 14-byte frames (same math as `tools/ble_imu_stream.py`).
- Fuses gyro + accel with a 6-axis **Madgwick AHRS** filter into an orientation
  quaternion; drives a live 3D glTF model (rendered with the `<model-viewer>` web
  component) plus a roll/pitch/yaw readout.
- Shows per-axis accel (g) and gyro (°/s) with bar indicators and a live sample rate.
- Cycles the IMU sample rate (0.25× … 4×) and lets you swap the displayed 3D model.
- Toggles the green LED (control register `0x0004`).

## Browser support

- Works in desktop **Chrome / Edge / Opera** (Chromium). **Safari and Firefox do not
  implement Web Bluetooth.**
- On macOS, grant the browser Bluetooth access in **System Settings → Privacy &
  Security → Bluetooth**.
- Requires a **secure context**: `https://` or `http://localhost`. Opening the file
  directly as `file://` will **not** work.

## Run it

**Published (recommended):** open the
<a href="../controller/" target="_blank" rel="noreferrer">live controller</a> — GitHub
Pages serves it over HTTPS, which is a secure context, so Web Bluetooth works directly,
no local server needed.

**Locally:**

```bash
cd docs/public/controller
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome. `localhost` counts as a secure context, so
Web Bluetooth is enabled with no certificate setup.

> Only one BLE central can hold the token at a time — close any running bleak script
> (`ble_nus.py`, `ble_dump.py`, `ble_imu_stream.py`) first.

## Usage

1. Click **Connect** and pick `TRIKI <serial>` in the chooser.
2. The page sends the start command automatically; status turns to *streaming* and the
   rate settles around **104 Hz**.
3. Move the token — the 3D model follows. Flat on a table, the Z accel axis reads
   ≈ +1.00 g. Drag the model to orbit the camera.
4. **LED** toggles the green LED; **Reset** re-zeros the heading (yaw) only, so tilt
   stays gravity-levelled. The **rate** button steps the IMU sample rate
   (0.25× = 26 Hz … 4× = 416 Hz; 1× = 104 Hz), and the dropdown switches the 3D model.

## Protocol mapping

See the [BLE protocol](./ble-protocol) and [IMU streaming](./imu-streaming) pages for
the authoritative spec; the page mirrors it:

| Item | Value |
|---|---|
| Service (NUS) | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (write) | `6e400002-…` — start command (the LED is on `…0004`, not here) |
| TX (notify) | `6e400003-…` — 14-byte IMU frames |
| Control (LED) | `6e400004-…` — 1-bit: `0x01` on / `0x00` off |
| Start command | `20 10 00 D0 07 68 00 03` (write to RX) |
| Frame | `22 00 \| gyroX gyroY gyroZ \| accelX accelY accelZ` |
| Each axis | signed int16, little-endian |
| Scales | gyro / 14.286 (°/s), accel / 2048.0 (g) |

## Limitations

- **Yaw drifts** over time: 6-axis fusion has no magnetometer, so heading is relative —
  use *Reset* to re-zero it.
- The browser **cannot emit a real joystick / HID gamepad**; this page is a visualizer.
  A true controller bridge (joystick / OSC / HID) needs a native helper or a
  WebSocket/WebHID side channel.
