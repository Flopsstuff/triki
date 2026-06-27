# BLE protocol

Notes on the Triki BLE interface, captured with [bleak](./tooling) on macOS.

> **OPSEC:** device-identifying values (chip ID, any per-device value) are NOT
> recorded here — only structure is kept.

## Advertising

Name `TRIKI <serial>` / `Triki <serial>`, address `XX:XX:XX:XX:XX:XX` (random static),
service `0x0001`.

## GATT

```
Nordic UART Service  6e400001-b5a3-f393-e0a9-e50e24dcca9e
  RX   …0002  [write, write-no-response]   commands host -> token
  TX   …0003  [notify]                     responses token -> host
  ctrl …0004  [read, write]                control register
Battery 0x180F → 0x2A19 (Battery Level)
```

The token speaks a **request/response protocol over NUS**: TX stays silent until a
command arrives on RX.

## Control register 0x0004 — green LED

- **1-bit flag.** Writes saturate: `0x00` → reads back `0x00`; any value `>= 0x01`
  → reads back `0x01`. Effective search space = 2 states.
- **Bit0 directly drives the green LED**: `0x01` = green on, `0x00` = off —
  immediate, no timeout (confirmed visually).

## RX 0x0002 — command interface

- Commands are **byte sequences** (byte0 = opcode). Some are single-byte, some are
  multi-byte (e.g. the 8-byte IMU start command — see [IMU streaming](./imu-streaming)).
- **Response opcode = request opcode | 0x80** (bit7 set = "this is a reply"),
  delivered on TX as one or more 20-byte notification packets.
- A few opcodes reboot the device (short LED blink, link drops, comes back as the same
  device — a soft reset).

### Opcode map (RX → TX), so far

| Opcode | Reply | Meaning / notes |
|---|---|---|
| `0x05` | `85` + 12 bytes | **static** config/status — does NOT change with motion |
| `0x07` | `87` + 8 bytes | device unique ID — stable across reads; value redacted |
| `0x09` | `89` + ~54 bytes (multi-packet) | status block — counter + state fields; NOT motion data |
| `0x0c` | `8c 01 00 00 00` | short status/counter |
| `0x43` | `c3` + ~54 bytes | changes every read → live buffer/counter; value redacted |
| `0x0a`, `0x42`, `0x44`, `0x46` | — | reboot (soft reset) |
| all other `0x00`–`0x7f` | — | silent (no single-byte reply; likely need parameters) |

The raw IMU is **not** on these single-byte opcodes — it comes from the dedicated
start-stream command on the [IMU streaming](./imu-streaming) page.
