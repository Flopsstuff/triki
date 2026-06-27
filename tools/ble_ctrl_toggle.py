#!/usr/bin/env python3
"""Toggle ctrl 0004 through a sequence and announce the expected LED state, so the
ctrl-bit <-> LED mapping can be confirmed by eye. Logs any TX during the run.

Run: ble_ctrl_toggle.py <name-or-uuid>
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

CTRL = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

# (value, expected LED, hold seconds)
SEQ = [
    (0x00, "OFF", 3),
    (0x01, "GREEN (on)", 5),
    (0x00, "OFF", 3),
    (0x01, "GREEN (on)", 5),
    (0x00, "OFF", 2),
]


def ts() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


async def find(target: str):
    t = target.lower()
    print(f"Looking for '{target}' (up to 15s)...")
    return await BleakScanner.find_device_by_filter(
        lambda d, adv: d.address.lower() == t
        or t in (d.name or "").lower()
        or t in (adv.local_name or "").lower(),
        timeout=15,
    )


async def main(target: str):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token and disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...\n")
    async with BleakClient(dev) as client:

        def on_tx(_, data: bytearray):
            print(f"{ts()}  TX {bytes(data).hex()}  {bytes(data)!r}")

        for svc in client.services:
            for ch in svc.characteristics:
                if "notify" in ch.properties:
                    try:
                        await client.start_notify(ch, on_tx)
                    except Exception:
                        pass

        for value, expect, hold in SEQ:
            await client.write_gatt_char(CTRL, bytes([value]), response=True)
            rb = bytes(await client.read_gatt_char(CTRL))
            print(f"{ts()}  ctrl=0x{value:02x} (rb=0x{rb.hex()})  -> LED should be: {expect}   [{hold}s]")
            await asyncio.sleep(hold)
        print("\nDone. Did the LED follow OFF/GREEN exactly, or stay on past ctrl=0?")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_ctrl_toggle.py <name-or-uuid>")
        sys.exit(1)
    try:
        asyncio.run(main(sys.argv[1]))
    except KeyboardInterrupt:
        pass
