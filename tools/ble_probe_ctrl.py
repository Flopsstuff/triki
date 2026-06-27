#!/usr/bin/env python3
"""Sweep the NUS control characteristic 0004 and watch for any reaction.

For each byte value in [start, end] it:
  1. writes the value to char 0004 (write-with-response) and records success/error,
  2. reads 0004 back (did it latch, or auto-clear?),
  3. logs any TX (0003) notifications, attributing them to the last value written,
  4. detects disconnects (a value that triggers a reset drops the link).
Restores 0x00 at the end.

Run: ble_probe_ctrl.py <name-or-uuid> [start] [end] [delay_s]
     defaults: start=0 end=255 delay=0.3

WARNING: writing changes device state. Some value could trigger a reset.
Your own device, recoverable via the app — but go in stages.
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
CTRL = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"
BAT = "00002a19-0000-1000-8000-00805f9b34fb"

state = {"v": 0}


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


async def main(target: str, start: int, end: int, delay: float):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token, keep it close, disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")

    tx_events = []

    async with BleakClient(dev) as client:

        def on_tx(_, data: bytearray):
            line = f"{ts()}  [@v=0x{state['v']:02x}] TX {bytes(data).hex()}  {bytes(data)!r}"
            print("   >>>", line)
            tx_events.append(line)

        await client.start_notify(NUS_TX, on_tx)
        base_ctrl = bytes(await client.read_gatt_char(CTRL))
        base_bat = (await client.read_gatt_char(BAT))[0]
        print(f"baseline: ctrl=0x{base_ctrl.hex()}  battery={base_bat}%\n")

        accepted, rejected, latched = [], [], []
        last_written = None
        for v in range(start, end + 1):
            state["v"] = v
            last_written = v
            try:
                await client.write_gatt_char(CTRL, bytes([v]), response=True)
                ok, err = True, ""
            except Exception as e:
                ok, err = False, str(e).splitlines()[0][:60]
            await asyncio.sleep(delay)
            if not client.is_connected:
                print(f"0x{v:02x}: write={'OK' if ok else 'ERR'} -> *** DISCONNECTED ***")
                break
            try:
                rb = bytes(await client.read_gatt_char(CTRL))
            except Exception as e:
                rb = b""
                print(f"0x{v:02x}: readback failed: {str(e).splitlines()[0][:50]}")
            note = ""
            if ok:
                accepted.append(v)
            else:
                rejected.append((v, err))
                note = f"  ERR={err}"
            if rb == bytes([v]):
                latched.append(v)
                note += "  (latched)"
            elif rb and rb != base_ctrl:
                note += f"  rb=0x{rb.hex()}"
            print(f"0x{v:02x}: write={'OK ' if ok else 'ERR'}  rb=0x{rb.hex() or '--'}{note}")

        # restore
        try:
            if client.is_connected:
                await client.write_gatt_char(CTRL, b"\x00", response=True)
                print("\nrestored ctrl=0x00")
        except Exception:
            pass

        print("\n===== SUMMARY =====")
        print(f"range 0x{start:02x}..0x{end:02x}, last written 0x{last_written:02x}")
        print(f"accepted (write OK): {len(accepted)}  rejected: {len(rejected)}")
        if rejected:
            print("  rejected sample:", rejected[:5])
        print(f"latched (read back == written): {['0x%02x' % x for x in latched] or 'none'}")
        print(f"TX events seen: {len(tx_events)}")
        for e in tx_events:
            print("  ", e)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_probe_ctrl.py <name-or-uuid> [start] [end] [delay_s]")
        sys.exit(1)
    s = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0
    e = int(sys.argv[3], 0) if len(sys.argv) > 3 else 255
    d = float(sys.argv[4]) if len(sys.argv) > 4 else 0.3
    try:
        asyncio.run(main(sys.argv[1], s, e, d))
    except KeyboardInterrupt:
        pass
