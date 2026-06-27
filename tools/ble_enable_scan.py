#!/usr/bin/env python3
"""Find the 'enable / active mode' command.

For each opcode it: writes the opcode to RX, reads ctrl 0004 (the green-LED / active
flag) to see if the opcode switched the device active, and logs any TX. Resets
ctrl=0 between opcodes. Skips the known reboot opcodes. Keep the token MOVING so a
motion stream (if any) shows up.

Run: ble_enable_scan.py <name-or-uuid> [start_hex] [end_hex]
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
CTRL = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"
REBOOT_OPS = {0x0A, 0x42, 0x44, 0x46}

state = {"op": -1}
tx_hits = {}
disc = {"v": False}


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


def on_tx(_, data: bytearray):
    op = state["op"]
    tx_hits.setdefault(op, []).append(bytes(data).hex())
    print(f"{ts()}  [op=0x{op:02x}] TX {bytes(data).hex()}")


async def connect(target: str):
    for _ in range(8):
        dev = await find(target)
        if dev:
            c = BleakClient(dev, disconnected_callback=lambda _: disc.update(v=True))
            try:
                await c.connect()
                await asyncio.sleep(0.4)
                if not any(ch.uuid.lower() == TX for s in c.services for ch in s.characteristics):
                    await c.disconnect()
                    await asyncio.sleep(1.5)
                    continue
                disc["v"] = False
                await c.start_notify(TX, on_tx)
                return c
            except Exception:
                try:
                    await c.disconnect()
                except Exception:
                    pass
        await asyncio.sleep(2)
    return None


async def main(target: str, start: int, end: int):
    client = await connect(target)
    if client is None:
        print("Cannot connect.")
        return
    enabled = []
    op = start
    while op <= end:
        if op in REBOOT_OPS:
            op += 1
            continue
        state["op"] = op
        if disc["v"] or not client.is_connected:
            try:
                await client.disconnect()
            except Exception:
                pass
            client = await connect(target)
            if client is None:
                print(f"!!! UNREACHABLE at 0x{op:02x} — halting.")
                break
        try:
            await client.write_gatt_char(RX, bytes([op]), response=False)
            await asyncio.sleep(0.3)
            ctrl = bytes(await client.read_gatt_char(CTRL))
            if ctrl and ctrl[0] != 0x00:
                enabled.append((op, ctrl.hex()))
                print(f"0x{op:02x}: ctrl -> 0x{ctrl.hex()}  <<< ACTIVE")
            # reset
            await client.write_gatt_char(CTRL, b"\x00", response=True)
        except Exception:
            pass
        op += 1

    try:
        if client and client.is_connected:
            await client.disconnect()
    except Exception:
        pass

    print("\n===== SUMMARY =====")
    print(f"opcodes that set ctrl/active: {[('0x%02x' % o, v) for o, v in enabled] or 'NONE'}")
    print(f"opcodes that produced TX: {['0x%02x' % o for o in tx_hits] or 'NONE'}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_enable_scan.py <name-or-uuid> [start_hex] [end_hex]")
        sys.exit(1)
    s = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x00
    e = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0x7F
    try:
        asyncio.run(main(sys.argv[1], s, e))
    except KeyboardInterrupt:
        pass
