# Tooling

BLE tooling for reading the Triki token (nRF52810 + LSM6DSL). The scripts live in
`tools/` and run with the project's Python venv (`tools/.venv/`, gitignored).

## Installed

| Tool | Version | Purpose |
|---|---|---|
| `bleak` (venv) | 3.0.2 | Cross-platform BLE client (CoreBluetooth on macOS) |

## Read the device

```bash
# 1. find the token over the air (name/address/RSSI)
./.venv/bin/python ble_scan.py 8

# 2. connect and dump the GATT map
./.venv/bin/python ble_dump.py "<name-or-address-from-step-1>"
```

`ble_dump.py` enumerates the device's GATT services/characteristics, reads the
readable ones, and subscribes to notifications. The GATT map and protocol are on the
[BLE protocol](./ble-protocol) page.

## Decode the IMU stream

The headline tool — start the [IMU stream](./imu-streaming) and decode the 14-byte
motion frames into scaled gyro (deg/s) + accel (g):

```bash
./.venv/bin/python ble_imu_stream.py "Triki" 15
```

## Scripts

Run each with the venv interpreter. `<target>` is the token's BLE name or address
(from `ble_scan.py`):

- `ble_nus.py <target>` — interactive console (write RX, watch TX).
- `ble_opcode_sweep.py <target>` — map the command interface by single-byte opcode.
- `ble_rx_probe.py <target>` — probe RX with multi-byte payloads, classify each by reaction.
- `ble_enable_scan.py <target>` — sweep for an "enable / active mode" command.
- `ble_probe_ctrl.py <target>` / `ble_ctrl_toggle.py <target>` — exercise / toggle the green-LED ctrl register.
- `ble_listen.py <target>` — optionally set ctrl, then listen.
- `ble_poll.py <target> <opcodes>` / `ble_imu_test.py <target>` — correlate response columns with motion.

> Tip: the token sleeps within seconds when idle — keep it moving so it stays awake
> and reachable while a script connects.
