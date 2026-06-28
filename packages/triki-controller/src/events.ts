/** Public event payloads, the controller event map, and constructor options. */
import type { Quaternion, EulerAngles } from "./fusion";
import type { TrikiTransport } from "./transport";

/** Connection lifecycle state. */
export type ConnectionState = "disconnected" | "pairing" | "streaming";

/**
 * Selectable orientation-fusion algorithm. `"accel"` is accelerometer-only tilt (no
 * gyro, no yaw); `"none"` emits no `orientation` events at all.
 */
export type FusionAlgorithm = "madgwick" | "vqf" | "accel" | "none";

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
  /** Which filter produced this sample (`"madgwick"`, `"vqf"`, or `"accel"`). */
  algorithm: FusionAlgorithm;
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
  /** Battery level in percent (0–100), if the token exposes the Battery service. */
  battery: number;
  /** Index signature required by the typed emitter. */
  [key: string]: unknown;
}

export interface TrikiControllerOptions {
  /**
   * Orientation fusion algorithm, controlling whether `orientation` events fire.
   * `true` (default) ≡ `"madgwick"`; `false` ≡ `"none"`; or name an algorithm
   * directly (`"madgwick"` | `"vqf"` | `"accel"` | `"none"`).
   */
  fusion?: boolean | FusionAlgorithm;
  /** Initial IMU sample rate in Hz. Default 104. */
  rateHz?: number;
  /** Madgwick filter gain. Default 0.08. */
  beta?: number;
  /** VQF accelerometer low-pass time constant in seconds. Default 2.0. */
  tauAcc?: number;
  /** Gyro scale in LSB per deg/s. Default 14.286. */
  gyroScale?: number;
  /** Per-axis gyro correction (deg/s) subtracted from every sample. Default zeros. */
  gyroBias?: Vec3;
  /** Per-axis accel correction (g) subtracted from every sample. Default zeros. */
  accelBias?: Vec3;
  /**
   * BLE transport. Defaults to a `WebBluetoothTransport` (browser). Pass a
   * `NobleTransport` (from `triki-controller/node`) to receive outside the browser,
   * or any object implementing {@link TrikiTransport}.
   */
  transport?: TrikiTransport;
}
