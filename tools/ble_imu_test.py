#!/usr/bin/env python3
"""Poll opcode 0x09 for N seconds and report per-byte-column statistics.

Run it once while holding the token STILL, once while SHAKING, then compare which
response columns gain variance under motion (= IMU data) vs change anyway
(timer/RNG/RAM churn).

Run: ble_imu_test.py <target> [seconds] [hz]
"""
import asyncio
import statistics
import sys

from bleak import BleakClient, BleakScanner

RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"


async def find(target: str, timeout: float = 12):
    t = target.lower()
    return await BleakScanner.find_device_by_filter(
        lambda d, adv: d.address.lower() == t
        or t in (d.name or "").lower()
        or t in (adv.local_name or "").lower(),
        timeout=timeout,
    )


async def main(target: str, seconds: float, hz: float):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token, disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")
    rows = []
    async with BleakClient(dev) as client:

        def on_tx(_, data: bytearray):
            b = bytes(data)
            if b and b[0] == 0x89:
                rows.append(list(b))

        await client.start_notify(TX, on_tx)
        period = 1.0 / hz
        print(f"\nCapturing 0x09 for {seconds:.0f}s — follow the single instruction now...\n")
        for _ in range(int(seconds * hz)):
            try:
                await client.write_gatt_char(RX, b"\x09", response=False)
            except Exception:
                pass
            await asyncio.sleep(period)

    if len(rows) < 2:
        print(f"too few samples ({len(rows)})")
        return
    n = min(len(r) for r in rows)
    print(f"samples={len(rows)}  bytes/sample={n}\n")
    print("col  min  max  distinct  stdev")
    for c in range(n):
        col = [r[c] for r in rows]
        print(f"{c:3}  {min(col):3}  {max(col):3}  {len(set(col)):6}   {statistics.pstdev(col):6.1f}")
    print("\nfirst 6 raw samples:")
    for r in rows[:6]:
        print("  " + bytes(r).hex())


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_imu_test.py <target> [seconds] [hz]")
        sys.exit(1)
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
    hz = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
    try:
        asyncio.run(main(sys.argv[1], secs, hz))
    except KeyboardInterrupt:
        pass
