# triki — BLE tooling

Scripts for reading the Triki token (nRF52810 + LSM6DSL) over BLE. Run them with the
project's Python venv (`tools/.venv/`, gitignored).

> Full write-up (GATT map, command interface, IMU streaming) lives in the docs site —
> see the **Tooling** and **BLE protocol** pages under `docs/`. This file is the quickstart.

## Installed

| Tool | Version | Purpose |
|---|---|---|
| `bleak` | 3.0.2 | Cross-platform BLE client (CoreBluetooth on macOS), in the venv |

## Quickstart

```bash
# 1. find the token over the air (name/address/RSSI/advertising)
./.venv/bin/python ble_scan.py 8

# 2. connect and dump the GATT map
./.venv/bin/python ble_dump.py "<name-or-address-from-step-1>"

# 3. start + decode the live accel/gyro stream (the main goal)
./.venv/bin/python ble_imu_stream.py "Triki" 15

# interactive console: write commands to RX, watch TX
./.venv/bin/python ble_nus.py "Triki"
```

> The token sleeps within seconds when idle — keep it moving (shake it) so it stays
> awake and reachable while a script connects.

## Scripts

- `ble_scan.py` — BLE scanner
- `ble_dump.py` — connect, dump GATT, log notifications
- `ble_nus.py` — interactive NUS console (write RX, watch TX)
- `ble_imu_stream.py` — start + decode the 14-byte IMU motion frames
- `ble_opcode_sweep.py` — map the device's command interface
- `ble_probe_ctrl.py` / `ble_ctrl_toggle.py` — exercise / toggle the green-LED ctrl register
- `ble_listen.py` — optionally set ctrl, then listen
- `ble_poll.py` / `ble_imu_test.py` — correlate response columns with motion
