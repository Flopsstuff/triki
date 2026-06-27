#!/usr/bin/env python3
"""Sweep single-byte opcodes on RX 0002 and capture the TX 0003 responses.

The protocol is request/response: a command byte gets a reply whose first byte is
opcode|0x80. This stays on one connection, sends each opcode, waits briefly for the
reply, and reconnects only when an opcode reboots the device. Halts if the token
becomes unreachable (possible reset).

Run: ble_opcode_sweep.py <name-or-uuid> [start_hex] [end_hex]
     defaults: start=0x00 end=0x7f
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

state = {"op": -1}
responses = {}   # op -> list of response packets (hex)
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
    responses.setdefault(op, []).append(bytes(data).hex())
    print(f"{ts()}  [op=0x{op:02x}] TX {bytes(data).hex()}")


async def connect(target: str):
    for _ in range(8):
        dev = await find(target)
        if dev:
            c = BleakClient(dev, disconnected_callback=lambda _: disc.update(v=True))
            try:
                await c.connect()
                await asyncio.sleep(0.4)  # let GATT discovery settle after a reboot
                tx_ok = any(
                    ch.uuid.lower() == TX
                    for s in c.services
                    for ch in s.characteristics
                )
                if not tx_ok:
                    await c.disconnect()
                    await asyncio.sleep(1.5)
                    continue
                disc["v"] = False
                await c.start_notify(TX, on_tx)
                return c
            except Exception as e:
                print(f"  connect err: {str(e).splitlines()[0][:50]}")
                try:
                    await c.disconnect()
                except Exception:
                    pass
        await asyncio.sleep(2)
    return None


async def main(target: str, start: int, end: int):
    print(f"Opcode sweep 0x{start:02x}..0x{end:02x} on '{target}'. Keep token awake.\n")
    client = await connect(target)
    if client is None:
        print("Cannot connect.")
        return
    reboots, responded, silent = [], [], []
    op = start
    while op <= end:
        state["op"] = op
        if disc["v"] or not client.is_connected:
            print(f"  reconnecting before 0x{op:02x}...")
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
        except Exception:
            pass
        await asyncio.sleep(0.55)
        if disc["v"] or not client.is_connected:
            reboots.append(op)
            print(f"0x{op:02x}: REBOOT")
            op += 1
            continue
        if responses.get(op):
            responded.append(op)
        else:
            silent.append(op)
        op += 1

    try:
        if client and client.is_connected:
            await client.disconnect()
    except Exception:
        pass

    print("\n===== SUMMARY =====")
    print(f"responded: {len(responded)}  silent: {len(silent)}  reboots: {len(reboots)}")
    print(f"reboot opcodes: {['0x%02x' % x for x in reboots]}")
    print("\n-- opcodes that answered --")
    for op in responded:
        for pkt in responses[op]:
            print(f"  0x{op:02x} -> {pkt}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_opcode_sweep.py <name-or-uuid> [start_hex] [end_hex]")
        sys.exit(1)
    s = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x00
    e = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0x7f
    try:
        asyncio.run(main(sys.argv[1], s, e))
    except KeyboardInterrupt:
        pass
