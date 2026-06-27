#!/usr/bin/env python3
"""Scan for nearby BLE devices (via CoreBluetooth on macOS).
Shows name, address/UUID, RSSI, advertised services, manufacturer/service data.
Run:  ../tools/.venv/bin/python ble_scan.py [seconds]
"""
import asyncio
import sys
from bleak import BleakScanner


async def main(timeout: float):
    print(f"Scanning {timeout:.0f}s...  (Ctrl-C to stop)\n")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    rows = []
    for dev, adv in found.values():
        rows.append((adv.rssi if adv.rssi is not None else -999, dev, adv))
    rows.sort(key=lambda r: r[0], reverse=True)
    for rssi, dev, adv in rows:
        name = dev.name or adv.local_name or "(no name)"
        print(f"{rssi:4} dBm  {dev.address}  {name}")
        if adv.service_uuids:
            print(f"            services: {', '.join(adv.service_uuids)}")
        for cid, data in (adv.manufacturer_data or {}).items():
            print(f"            mfg 0x{cid:04x}: {bytes(data).hex()}")
        for uuid, data in (adv.service_data or {}).items():
            print(f"            svc-data {uuid}: {bytes(data).hex()}")
    print(f"\nDevices found: {len(rows)}")


if __name__ == "__main__":
    t = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
    try:
        asyncio.run(main(t))
    except KeyboardInterrupt:
        pass
