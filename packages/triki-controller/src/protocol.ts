/**
 * Protocol constants and command builders for the Żabka Triki BLE token.
 *
 * The token speaks a request/response protocol over the Nordic UART Service (NUS).
 * All UUIDs here are generic Nordic/standard BLE UUIDs and are not device-specific.
 */

/** Nordic UART Service. */
export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
/** NUS RX characteristic — host -> token commands (write / write-without-response). */
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** NUS TX characteristic — token -> host motion frames (notify). */
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
/** Control register — 1 byte, drives the green LED (0x01 on / 0x00 off). */
export const NUS_CTRL = "6e400004-b5a3-f393-e0a9-e50e24dcca9e";

/** Standard Battery Service (0x180F). */
export const BATTERY_SERVICE = "battery_service";
/** Standard Battery Level characteristic (0x2A19) — uint8 percent. */
export const BATTERY_LEVEL = "battery_level";

/**
 * Base bytes of the 8-byte IMU start command. Bytes 5-6 carry the sample rate
 * (ODR) as a little-endian uint16 in Hz; 0x0068 = 104 Hz is the default. Bytes
 * 3-4 (`D0 07`) and byte 7 (`03`) are a fixed, not-yet-decoded part of the command.
 */
export const START_BASE: readonly number[] = [0x20, 0x10, 0x00, 0xd0, 0x07, 0x68, 0x00, 0x03];

/** Motion-frame header byte 0. */
export const HEADER0 = 0x22;
/** Motion-frame header byte 1. */
export const HEADER1 = 0x00;
/** Motion-frame length in bytes (header + six int16 axes). */
export const FRAME_LEN = 14;

/** Accelerometer scale in LSB per g (LSM6DSL ±16 g; flat token reads +2048 = 1 g). */
export const DEFAULT_ACCEL_SCALE = 2048.0;
/**
 * Gyro scale in LSB per deg/s (LSM6DSL ±2000 dps, 70 mdps/LSB). NEVER 131.0 —
 * that is an MPU-6050 ±250 dps value and under-rotates ~9x on this token.
 */
export const DEFAULT_GYRO_SCALE = 14.286;

/** Default sample rate in Hz. */
export const DEFAULT_RATE_HZ = 104;
/** Default Madgwick filter gain. */
export const DEFAULT_BETA = 0.08;

/**
 * Firmware-accepted sample rates (Hz) — a subset of the LSM6DSL ODR ladder.
 * 12.5 Hz is rejected by the firmware; above ~208 Hz BLE may not keep up.
 */
export const SUPPORTED_RATES_HZ = [26, 52, 104, 208, 416] as const;
export type SupportedRateHz = (typeof SUPPORTED_RATES_HZ)[number];

/** Build the 8-byte START command for a given ODR (bytes 5-6 = rate, LE uint16). */
export function startCmd(hz: number): Uint8Array<ArrayBuffer> {
  const c = Uint8Array.from(START_BASE);
  c[5] = hz & 0xff;
  c[6] = (hz >> 8) & 0xff;
  return c;
}

/** Build the 1-byte LED control payload. */
export function ledCmd(on: boolean): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(on ? 0x01 : 0x00);
}
