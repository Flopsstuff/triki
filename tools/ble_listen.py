#!/usr/bin/env python3
"""Optionally set ctrl 0004, then listen to all notify characteristics for N seconds.

Use to test whether enabling the control flag makes the device stream on TX
(e.g. IMU/telemetry) or react to motion/button while connected.

Run: ble_listen.py <name-or-uuid> [seconds] [ctrl_hex]
     ble_listen.py triki 30 01     -> set ctrl=0x01, then listen 30s
     ble_listen.py triki 30        -> just listen 30s (no write)
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

CTRL = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"


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


async def main(target: str, seconds: float, ctrl_hex: str | None):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token and disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")
    count = {"n": 0}
    async with BleakClient(dev) as client:

        def make_cb(uuid):
            def cb(_, data: bytearray):
                count["n"] += 1
                print(f"{ts()}  {uuid}: {bytes(data).hex()}  {bytes(data)!r}")

            return cb

        for svc in client.services:
            for ch in svc.characteristics:
                if "notify" in ch.properties or "indicate" in ch.properties:
                    try:
                        await client.start_notify(ch, make_cb(ch.uuid))
                    except Exception as e:
                        print(f"  subscribe failed {ch.uuid}: {e}")

        if ctrl_hex:
            data = bytes.fromhex(ctrl_hex.replace(" ", ""))
            await client.write_gatt_char(CTRL, data, response=True)
            rb = bytes(await client.read_gatt_char(CTRL))
            print(f"{ts()}  wrote ctrl=0x{data.hex()}, readback=0x{rb.hex()}")

        print(f"\nListening {seconds:.0f}s — MOVE/SHAKE the token, press its button...\n")
        await asyncio.sleep(seconds)
        print(f"\nDone. Notifications received: {count['n']}")
        if ctrl_hex:
            try:
                await client.write_gatt_char(CTRL, b"\x00", response=True)
                print("restored ctrl=0x00")
            except Exception:
                pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_listen.py <name-or-uuid> [seconds] [ctrl_hex]")
        sys.exit(1)
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
    ch = sys.argv[3] if len(sys.argv) > 3 else None
    try:
        asyncio.run(main(sys.argv[1], secs, ch))
    except KeyboardInterrupt:
        pass
