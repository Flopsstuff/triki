#!/usr/bin/env python3
"""Connect to a BLE device, dump the whole GATT, and capture notifications.

Enumerates all services/characteristics/descriptors with their properties, reads
every readable characteristic, then subscribes to all notify/indicate and logs
incoming traffic with timestamps for a given window before disconnecting cleanly.

Run:    ../tools/.venv/bin/python ble_dump.py <address-or-name> [listen-seconds]
Example: ../tools/.venv/bin/python ble_dump.py TRIKI 30
Stop:    Ctrl-C (or when the window expires)
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner


def ts() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


async def find(target: str):
    t = target.lower()
    print(f"Looking for '{target}' (up to 15s)...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, adv: d.address.lower() == t
        or t in (d.name or "").lower()
        or t in (adv.local_name or "").lower(),
        timeout=15,
    )
    return dev


async def main(target: str, listen_s: float):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Make sure the token is on, advertising, and "
              f"NOT connected to the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")

    done = asyncio.Event()

    def on_disconnect(_):
        print(f"{ts()}  *** device disconnected ***")
        done.set()

    async with BleakClient(dev, disconnected_callback=on_disconnect) as client:
        print("Connected. GATT map:\n")
        for svc in client.services:
            print(f"[service] {svc.uuid}  {svc.description}")
            for ch in svc.characteristics:
                props = ",".join(ch.properties)
                val = ""
                if "read" in ch.properties:
                    try:
                        b = await client.read_gatt_char(ch)
                        val = f"  = {bytes(b).hex()}  {bytes(b)!r}"
                    except Exception as e:
                        val = f"  (read error: {e})"
                print(f"  [char] {ch.uuid} [{props}]{val}")
                for desc in ch.descriptors:
                    try:
                        b = await client.read_gatt_descriptor(desc.handle)
                        print(f"      [desc] {desc.uuid} = {bytes(b).hex()}")
                    except Exception:
                        print(f"      [desc] {desc.uuid}")

        def make_cb(uuid):
            def cb(_, data: bytearray):
                print(f"{ts()}  NOTIFY {uuid}: {bytes(data).hex()}  {bytes(data)!r}")

            return cb

        subs = []
        for svc in client.services:
            for ch in svc.characteristics:
                if "notify" in ch.properties or "indicate" in ch.properties:
                    try:
                        await client.start_notify(ch, make_cb(ch.uuid))
                        subs.append(ch.uuid)
                    except Exception as e:
                        print(f"  subscribe failed {ch.uuid}: {e}")

        print(f"\nSubscribed to {len(subs)} characteristics. Listening {listen_s:.0f}s "
              f"(Ctrl-C to stop)...\n")
        try:
            await asyncio.wait_for(done.wait(), timeout=listen_s)
        except asyncio.TimeoutError:
            print(f"\n{ts()}  listen window expired, disconnecting.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_dump.py <address-or-name> [seconds]")
        sys.exit(1)
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    try:
        asyncio.run(main(sys.argv[1], secs))
    except KeyboardInterrupt:
        pass
