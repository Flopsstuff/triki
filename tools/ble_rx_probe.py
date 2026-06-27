#!/usr/bin/env python3
"""Probe RX 0002 with a curated payload list; classify each by reaction.

For each payload it makes a fresh connection, subscribes to TX (0003), writes the
payload to RX (write-no-response), waits, then classifies:
  TX:<hex>  - the device answered on TX
  REBOOT    - the link dropped (device reset)
  silent    - accepted, no answer, still connected
If the token can't be reached for the next payload (possible reset/stuck/asleep), it
halts instead of looping blindly.

Run: ble_rx_probe.py <name-or-uuid>
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

# hex payload -> human note
PAYLOADS = [
    ("0a", "lone \\n (confirm reboot)"),
    ("01", "single 0x01"),
    ("05", "single 0x05"),
    ("09", "single 0x09"),
    ("0b", "single 0x0b"),
    ("0f", "single 0x0f"),
    ("3f0a", "?\\n"),
    ("68656c700a", "help\\n"),
    ("696e666f0a", "info\\n"),
    ("76657273696f6e0a", "version\\n"),
    ("7374617475730a", "status\\n"),
    ("41540d0a", "AT\\r\\n"),
]


def ts() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


async def find(target: str, timeout: float = 12):
    t = target.lower()
    return await BleakScanner.find_device_by_filter(
        lambda d, adv: d.address.lower() == t
        or t in (d.name or "").lower()
        or t in (adv.local_name or "").lower(),
        timeout=timeout,
    )


async def probe_one(target: str, payload_hex: str, note: str):
    dev = await find(target)
    if dev is None:
        return "UNREACHABLE", []
    tx = []
    dropped = {"v": False}

    def on_disc(_):
        dropped["v"] = True

    try:
        client = BleakClient(dev, disconnected_callback=on_disc)
        await client.connect()
    except Exception as e:
        return f"CONNECT-ERR ({str(e).splitlines()[0][:40]})", []

    try:
        def on_tx(_, data: bytearray):
            tx.append(bytes(data))
            print(f"{ts()}     <- TX {bytes(data).hex()}  {bytes(data)!r}")

        await client.start_notify(TX, on_tx)
        await client.write_gatt_char(RX, bytes.fromhex(payload_hex), response=False)
        await asyncio.sleep(1.6)
        alive = client.is_connected and not dropped["v"]
    except Exception:
        alive = False
    finally:
        try:
            if client.is_connected:
                await client.disconnect()
        except Exception:
            pass

    if tx:
        return "TX:" + " ".join(b.hex() for b in tx), tx
    if not alive:
        return "REBOOT", []
    return "silent", []


async def main(target: str):
    print(f"RX probe on '{target}'. Keep the token awake and near the Mac.\n")
    results = []
    for payload_hex, note in PAYLOADS:
        print(f"--- payload {payload_hex}  ({note})")
        verdict, tx = await probe_one(target, payload_hex, note)
        print(f"    => {verdict}\n")
        results.append((payload_hex, note, verdict))
        if verdict == "UNREACHABLE":
            print("!!! token not reachable — stopping (asleep, held by phone, or "
                  "stuck/reset). Re-run when it's advertising as 'Triki'.")
            break
        await asyncio.sleep(1.0)

    print("\n===== SUMMARY =====")
    for payload_hex, note, verdict in results:
        print(f"  {payload_hex:<18} {note:<22} {verdict}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_rx_probe.py <name-or-uuid>")
        sys.exit(1)
    try:
        asyncio.run(main(sys.argv[1]))
    except KeyboardInterrupt:
        pass
