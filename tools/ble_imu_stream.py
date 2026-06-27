#!/usr/bin/env python3
"""Start the Triki IMU stream and decode the 14-byte motion frames.

Protocol (from ref/ BLE notes): send the init command to RX, then TX delivers
14-byte frames:
    22 00 | gyroX gyroY gyroZ | accelX accelY accelZ   (each int16, little-endian)
Scales: gyro / 131.0 (deg/s), accel / 2048.0 (g). Frames burst at ~104 Hz.

Run: ble_imu_stream.py <name-or-uuid> [seconds]
"""
import asyncio
import datetime
import struct
import sys

from bleak import BleakClient, BleakScanner

RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
START = bytes.fromhex("201000d007680003")  # 20 10 00 D0 07 68 00 03
GYRO_SCALE = 131.0
ACCEL_SCALE = 2048.0
HDR = b"\x22\x00"


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


async def main(target: str, seconds: float):
    dev = await find(target)
    if dev is None:
        print(f"Not found: {target}. Wake the token, disconnect the phone.")
        return
    print(f"Connecting to {dev.address} ({dev.name})...")
    buf = bytearray()
    stats = {"frames": 0}
    async with BleakClient(dev) as client:

        def on_tx(_, data: bytearray):
            buf.extend(bytes(data))
            # extract 14-byte frames starting with the 22 00 header
            while True:
                j = buf.find(HDR)
                if j < 0:
                    if len(buf) > 64:
                        del buf[:-1]
                    break
                if j > 0:
                    del buf[:j]  # drop garbage before header
                if len(buf) < 14:
                    break
                frame = bytes(buf[:14])
                del buf[:14]
                gx, gy, gz, ax, ay, az = struct.unpack_from("<hhhhhh", frame, 2)
                stats["frames"] += 1
                if stats["frames"] % 8 == 1:  # print ~1 of every 8 frames
                    print(f"{ts()}  gyro=({gx:6},{gy:6},{gz:6})  "
                          f"accel=({ax:6},{ay:6},{az:6})   "
                          f"[{gx/GYRO_SCALE:6.1f},{gy/GYRO_SCALE:6.1f},{gz/GYRO_SCALE:6.1f}]°/s "
                          f"[{ax/ACCEL_SCALE:5.2f},{ay/ACCEL_SCALE:5.2f},{az/ACCEL_SCALE:5.2f}]g")

        await client.start_notify(TX, on_tx)
        await client.write_gatt_char(RX, START, response=False)
        print(f"sent START ({START.hex()}). Streaming {seconds:.0f}s — MOVE/ROTATE the token...\n")
        await asyncio.sleep(seconds)
        print(f"\nframes received: {stats['frames']}  (~{stats['frames']/seconds:.0f} Hz)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ble_imu_stream.py <name-or-uuid> [seconds]")
        sys.exit(1)
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
    try:
        asyncio.run(main(sys.argv[1], secs))
    except KeyboardInterrupt:
        pass
