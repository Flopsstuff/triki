#!/usr/bin/env python3
"""Interactive NUS console for Triki: write commands to RX, listen on TX.

Connects, subscribes to TX (notify), and reads commands from stdin. Logs ALL TX
notifications with timestamps.

Interactive commands:
  hex AABBCC      send bytes AA BB CC to RX (0002, write-no-response)
  hexr AABBCC     same, but with response (write with response)
  txt hello       send an ASCII string to RX
  ctrl 01         write byte(s) 0x01 to the control char 0004
  read4           read char 0004
  bat             read the battery level
  help            help
  q               quit

WARNING: writing to RX/0004 changes device state. In theory an unknown command
could put the token into a service/reset state. It is your device — but don't be
surprised if you have to re-initialize it via the app afterwards.

Run:  ../tools/.venv/bin/python ble_nus.py <name-or-uuid>
"""
import asyncio
import datetime
import sys

from bleak import BleakClient, BleakScanner

NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
CTRL = "6e400004-b5a3-f393-e0a9-e50e24dcca9e"
BAT = "00002a19-0000-1000-8000-00805f9b34fb"

HELP = __doc__


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


async def handle(client: BleakClient, line: str) -> bool:
    parts = line.split(None, 1)
    cmd = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""
    if cmd in ("q", "quit", "exit"):
        return False
    if cmd == "help":
        print(HELP)
    elif cmd == "bat":
        b = await client.read_gatt_char(BAT)
        print(f"battery = {int(b[0])}%")
    elif cmd == "read4":
        b = await client.read_gatt_char(CTRL)
        print(f"ctrl(0004) = {bytes(b).hex()}  {bytes(b)!r}")
    elif cmd == "ctrl":
        data = bytes.fromhex(arg.replace(" ", ""))
        await client.write_gatt_char(CTRL, data, response=True)
        print(f"{ts()} -> ctrl(0004) WROTE {data.hex()}")
    elif cmd in ("hex", "hexr"):
        data = bytes.fromhex(arg.replace(" ", ""))
        await client.write_gatt_char(NUS_RX, data, response=(cmd == "hexr"))
        print(f"{ts()} -> RX WROTE {data.hex()}")
    elif cmd == "txt":
        data = arg.encode()
        await client.write_gatt_char(NUS_RX, data, response=False)
        print(f"{ts()} -> RX WROTE {data!r}")
    else:
        print("unknown; see help")
    return True


async def main(target: str):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token and disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")
    async with BleakClient(dev) as client:

        def on_tx(_, data: bytearray):
            print(f"{ts()} <- TX {bytes(data).hex()}  {bytes(data)!r}")

        await client.start_notify(NUS_TX, on_tx)
        print("Connected, subscribed to TX.\n" + HELP)
        loop = asyncio.get_event_loop()
        while client.is_connected:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                if not await handle(client, line):
                    break
            except Exception as e:
                print("error:", e)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_nus.py <name-or-uuid>")
        sys.exit(1)
    try:
        asyncio.run(main(sys.argv[1]))
    except KeyboardInterrupt:
        pass
