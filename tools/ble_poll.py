#!/usr/bin/env python3
"""Poll one or more opcodes in a loop and print responses, decoded as int16, to
spot motion-correlated changes. Shake the token while this runs.

Prints only when a response CHANGES from the previous one for that opcode, so a
static value is quiet and motion shows up as a burst.

Run: ble_poll.py <target> <opcodes_csv_hex> [hz_per_op] [seconds]
Example: ble_poll.py triki 05,09 8 25
"""
import asyncio
import datetime
import struct
import sys

from bleak import BleakClient, BleakScanner

RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"


def ts() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def i16le(b: bytes):
    return [struct.unpack_from("<h", b, i)[0] for i in range(0, len(b) - 1, 2)]


async def find(target: str, timeout: float = 12):
    t = target.lower()
    return await BleakScanner.find_device_by_filter(
        lambda d, adv: d.address.lower() == t
        or t in (d.name or "").lower()
        or t in (adv.local_name or "").lower(),
        timeout=timeout,
    )


async def main(target: str, ops, hz: float, seconds: float):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token, disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")
    last = {}
    counts = {op: 0 for op in ops}
    changes = {op: 0 for op in ops}
    async with BleakClient(dev) as client:

        def on_tx(_, data: bytearray):
            b = bytes(data)
            op = b[0] & 0x7F
            counts[op] = counts.get(op, 0) + 1
            h = b.hex()
            if last.get(op) != h:
                last[op] = h
                changes[op] = changes.get(op, 0) + 1
                print(f"{ts()}  0x{op:02x} <- {h}   i16le={i16le(b[1:])}")

        await client.start_notify(TX, on_tx)
        period = 1.0 / (hz * len(ops))
        cycles = int(seconds * hz)
        print(f"\nPolling {['0x%02x' % o for o in ops]} for {seconds:.0f}s "
              f"— SHAKE / ROTATE THE TOKEN NOW (vary gentle vs hard)\n")
        for _ in range(cycles):
            for op in ops:
                try:
                    await client.write_gatt_char(RX, bytes([op]), response=False)
                except Exception:
                    pass
                await asyncio.sleep(period)

        print("\n===== SUMMARY =====")
        for op in ops:
            print(f"  0x{op:02x}: {counts.get(op,0)} responses, "
                  f"{changes.get(op,0)} distinct values")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: ble_poll.py <name-or-uuid> <opcodes_csv_hex> [hz] [seconds]")
        sys.exit(1)
    ops = [int(x, 16) for x in sys.argv[2].split(",")]
    hz = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
    secs = float(sys.argv[4]) if len(sys.argv) > 4 else 25.0
    try:
        asyncio.run(main(sys.argv[1], ops, hz, secs))
    except KeyboardInterrupt:
        pass
