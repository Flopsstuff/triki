import { describe, test, expect } from "vitest";
import {
  startCmd,
  ledCmd,
  START_BASE,
  HEADER0,
  HEADER1,
  FRAME_LEN,
  DEFAULT_ACCEL_SCALE,
  DEFAULT_GYRO_SCALE,
  DEFAULT_RATE_HZ,
  DEFAULT_BETA,
  SUPPORTED_RATES_HZ,
} from "./protocol";

describe("startCmd", () => {
  test("default 104 Hz produces the canonical START bytes", () => {
    expect(Array.from(startCmd(104))).toEqual([0x20, 0x10, 0x00, 0xd0, 0x07, 0x68, 0x00, 0x03]);
  });

  test("encodes the rate as a little-endian uint16 at bytes 5-6", () => {
    // low byte, high byte
    expect(Array.from(startCmd(26)).slice(5, 7)).toEqual([0x1a, 0x00]);
    expect(Array.from(startCmd(52)).slice(5, 7)).toEqual([0x34, 0x00]);
    expect(Array.from(startCmd(208)).slice(5, 7)).toEqual([0xd0, 0x00]);
    expect(Array.from(startCmd(416)).slice(5, 7)).toEqual([0xa0, 0x01]);
  });

  test("leaves the fixed bytes (0-4, 7) untouched regardless of rate", () => {
    for (const hz of SUPPORTED_RATES_HZ) {
      const cmd = Array.from(startCmd(hz));
      expect(cmd[0]).toBe(0x20);
      expect(cmd[1]).toBe(0x10);
      expect(cmd[2]).toBe(0x00);
      expect(cmd[3]).toBe(0xd0);
      expect(cmd[4]).toBe(0x07);
      expect(cmd[7]).toBe(0x03);
      expect(cmd).toHaveLength(8);
    }
  });

  test("masks the rate to 16 bits", () => {
    expect(Array.from(startCmd(0x1_0068)).slice(5, 7)).toEqual([0x68, 0x00]);
  });

  test("returns a fresh array each call (does not mutate START_BASE)", () => {
    startCmd(416);
    expect(START_BASE.slice()).toEqual([0x20, 0x10, 0x00, 0xd0, 0x07, 0x68, 0x00, 0x03]);
  });
});

describe("ledCmd", () => {
  test("on -> 0x01, off -> 0x00", () => {
    expect(Array.from(ledCmd(true))).toEqual([0x01]);
    expect(Array.from(ledCmd(false))).toEqual([0x00]);
  });
});

describe("protocol constants (regression guards)", () => {
  test("gyro scale is 14.286 LSB/(deg/s), never the MPU-6050 value 131", () => {
    expect(DEFAULT_GYRO_SCALE).toBe(14.286);
    expect(DEFAULT_GYRO_SCALE).not.toBe(131.0);
  });

  test("accel scale, frame layout and rate ladder", () => {
    expect(DEFAULT_ACCEL_SCALE).toBe(2048.0);
    expect(FRAME_LEN).toBe(14);
    expect(HEADER0).toBe(0x22);
    expect(HEADER1).toBe(0x00);
    expect(DEFAULT_RATE_HZ).toBe(104);
    expect(DEFAULT_BETA).toBe(0.08);
    expect(Array.from(SUPPORTED_RATES_HZ)).toEqual([26, 52, 104, 208, 416]);
  });
});
