/** Public event payloads, the controller event map, and constructor options. */
import type { Quaternion, EulerAngles } from "./fusion";

/** Connection lifecycle state. */
export type ConnectionState = "disconnected" | "pairing" | "streaming";

/** A 3-component vector. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One decoded motion frame: raw counts plus scaled gyro (deg/s) and accel (g). */
export interface FrameEvent {
  /** Raw signed-16 sensor counts. */
  raw: { gx: number; gy: number; gz: number; ax: number; ay: number; az: number };
  /** Gyro in deg/s. */
  gyro: Vec3;
  /** Accel in g. */
  accel: Vec3;
  /** `performance.now()` timestamp in ms. */
  t: number;
}

/** Fused orientation. Emitted only when fusion is enabled. */
export interface OrientationEvent {
  /** `[w, x, y, z]`, right-handed math frame, heading offset applied. */
  quaternion: Quaternion;
  /** Tait-Bryan angles in degrees, heading offset applied. */
  euler: EulerAngles;
  /** `performance.now()` timestamp in ms. */
  t: number;
}

/** Maps each event type to its payload. */
export interface TrikiEventMap {
  /** Every decoded motion frame (raw + scaled). */
  frame: FrameEvent;
  /** Fused orientation — only when fusion is enabled. */
  orientation: OrientationEvent;
  /** Connection state changed; payload is the new state. */
  connectionchange: ConnectionState;
  /** Measured throughput in Hz (frames in the last 1000 ms), emitted ~once per second. */
  rate: number;
  /** Index signature required by the typed emitter. */
  [key: string]: unknown;
}

export interface TrikiControllerOptions {
  /** Run Madgwick fusion and emit `orientation` events. Default `true`. */
  fusion?: boolean;
  /** Initial IMU sample rate in Hz. Default 104. */
  rateHz?: number;
  /** Madgwick filter gain. Default 0.08. */
  beta?: number;
  /** Gyro scale in LSB per deg/s. Default 14.286. */
  gyroScale?: number;
}
