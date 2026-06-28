/**
 * Client for the Żabka Triki BLE token. Owns the IMU protocol (START/LED commands),
 * parses motion frames, and (optionally) fuses orientation with a selectable 6-axis
 * filter (Madgwick / VQF / accel-only). The actual BLE link is delegated to a
 * {@link TrikiTransport} — by default a `WebBluetoothTransport` (browser), or a
 * `NobleTransport` (Node) — so this module is transport-agnostic and never touches
 * `navigator.bluetooth` directly.
 */
import { TypedEmitter } from "./emitter";
import { FrameParser } from "./parser";
import type { RawFrame } from "./parser";
import { MadgwickAHRS, AccelAHRS, quatMul, quatAboutZ, yawRadOf, eulerOf } from "./fusion";
import type { OrientationFilter, Quaternion } from "./fusion";
import { VqfAHRS, DEFAULT_TAU_ACC } from "./vqf";
import {
  DEFAULT_ACCEL_SCALE,
  DEFAULT_GYRO_SCALE,
  DEFAULT_RATE_HZ,
  DEFAULT_BETA,
  startCmd,
  ledCmd,
} from "./protocol";
import { WebBluetoothTransport } from "./transports/web-bluetooth";
import type { TrikiTransport } from "./transport";
import type {
  ConnectionState,
  FusionAlgorithm,
  TrikiControllerOptions,
  TrikiEventMap,
  Vec3,
} from "./events";

const ZERO_VEC3: Vec3 = { x: 0, y: 0, z: 0 };

/** Finite, strictly-positive number or the fallback (guards gyro-scale div-by-zero). */
function finitePositive(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Defensive copy of a Vec3 with non-finite components coerced to 0. */
function copyVec3(v: Vec3): Vec3 {
  return {
    x: Number.isFinite(v.x) ? v.x : 0,
    y: Number.isFinite(v.y) ? v.y : 0,
    z: Number.isFinite(v.z) ? v.z : 0,
  };
}

/** Resolve the `fusion` option: `true`→madgwick, `false`→none, string→passthrough. */
function resolveFusion(opt: boolean | FusionAlgorithm | undefined): FusionAlgorithm {
  if (opt === undefined || opt === true) return "madgwick";
  if (opt === false) return "none";
  return opt;
}

const RATE_WINDOW_MS = 1000;
const MAX_DT_S = 0.2;

export class TrikiController extends TypedEmitter<TrikiEventMap> {
  #transport: TrikiTransport;
  #battery: number | null = null;

  #parser = new FrameParser();
  #filter: OrientationFilter | null;
  #algo: FusionAlgorithm;
  #beta: number;
  #tauAcc: number;
  #state: ConnectionState = "disconnected";
  #rateHz: number;
  #gyroScale: number;
  #gyroBias: Vec3;
  #accelBias: Vec3;
  #yawOffsetQ: Quaternion = [1, 0, 0, 0];
  #lastFrameTs = 0;
  #frameTimes: number[] = [];
  #rateTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TrikiControllerOptions = {}) {
    super();
    this.#algo = resolveFusion(options.fusion);
    this.#rateHz = options.rateHz ?? DEFAULT_RATE_HZ;
    this.#gyroScale = finitePositive(options.gyroScale ?? DEFAULT_GYRO_SCALE, DEFAULT_GYRO_SCALE);
    this.#gyroBias = copyVec3(options.gyroBias ?? ZERO_VEC3);
    this.#accelBias = copyVec3(options.accelBias ?? ZERO_VEC3);
    this.#beta = options.beta ?? DEFAULT_BETA;
    this.#tauAcc = options.tauAcc ?? DEFAULT_TAU_ACC;
    this.#filter = this.#makeFilter(this.#algo);
    this.#transport = options.transport ?? new WebBluetoothTransport();
    this.#transport.onFrame(this.#ingest);
    this.#transport.onDisconnect(this.#handleTransportDisconnect);
    this.#transport.onBattery(this.#handleBattery);
  }

  #makeFilter(algo: FusionAlgorithm): OrientationFilter | null {
    if (algo === "madgwick") return new MadgwickAHRS({ beta: this.#beta });
    if (algo === "vqf") return new VqfAHRS({ tauAcc: this.#tauAcc });
    if (algo === "accel") return new AccelAHRS();
    return null;
  }

  /** True when the default Web Bluetooth transport is available (safe during SSR). */
  static isSupported(): boolean {
    return WebBluetoothTransport.isSupported();
  }

  /** True while streaming. */
  get isConnected(): boolean {
    return this.#state === "streaming";
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this.#state;
  }

  /** Currently configured sample rate in Hz. */
  get rateHz(): number {
    return this.#rateHz;
  }

  /** True when the token exposes the LED control characteristic. */
  get hasLed(): boolean {
    return this.#transport.hasLed;
  }

  /** Last known battery level in percent, or `null` if not read yet. */
  get battery(): number | null {
    return this.#battery;
  }

  /** The active orientation filter, or `undefined` when fusion is disabled. */
  get fusion(): OrientationFilter | undefined {
    return this.#filter ?? undefined;
  }

  /** The active fusion algorithm. */
  get fusionAlgorithm(): FusionAlgorithm {
    return this.#algo;
  }

  /**
   * Connect through the transport and start the IMU stream. With the default Web
   * Bluetooth transport this shows the device picker and must be called from a user
   * gesture (e.g. a click handler). Rejects (after cleaning up) if the transport or
   * the handshake fails.
   */
  async connect(): Promise<void> {
    if (this.#state !== "disconnected") return;
    try {
      this.#setState("pairing");
      await this.#transport.connect();
      await this.#startStreaming();
    } catch (err) {
      this.#cleanup();
      throw err;
    }
  }

  /**
   * Reconnect to the previously selected device without re-prompting. Throws if the
   * transport does not support reconnecting (e.g. {@link connect} was never called).
   */
  async reconnect(): Promise<void> {
    if (this.#state !== "disconnected") return;
    if (!this.#transport.reconnect) {
      throw new Error("This transport does not support reconnect().");
    }
    try {
      this.#setState("pairing");
      await this.#transport.reconnect();
      await this.#startStreaming();
    } catch (err) {
      this.#cleanup();
      throw err;
    }
  }

  /** Disconnect from the token. Triggers a `connectionchange` to `disconnected`. */
  disconnect(): void {
    if (this.#state === "disconnected") return;
    this.#transport.disconnect();
  }

  /** Turn the green LED on or off. Throws when the LED characteristic is unavailable. */
  async setLed(on: boolean): Promise<void> {
    if (!this.#transport.hasLed) throw new Error("LED control characteristic is not available.");
    await this.#transport.writeCtrl(ledCmd(on));
  }

  /**
   * Set the IMU sample rate (Hz). Applies immediately when streaming (re-sends the
   * START command), otherwise takes effect on the next {@link connect}.
   */
  async setRate(hz: number): Promise<void> {
    this.#rateHz = hz;
    // Keep VQF's accel low-pass aligned with the new sample period.
    if (this.#filter instanceof VqfAHRS) this.#filter.setSamplePeriod(1 / hz);
    if (this.#state === "streaming") await this.#transport.writeRx(startCmd(hz), true);
  }

  /** Re-zero the heading (yaw). No-op when fusion is disabled. Tilt stays absolute. */
  resetHeading(): void {
    if (!this.#filter) return;
    this.#yawOffsetQ = quatAboutZ(-yawRadOf(this.#filter.quaternion()));
  }

  /**
   * Switch the fusion algorithm at runtime. Rebuilds the filter and re-zeroes the
   * heading; `"none"` stops `orientation` events (and `resetHeading` becomes a no-op).
   */
  setFusion(algo: FusionAlgorithm): void {
    this.#algo = algo;
    this.#filter = this.#makeFilter(algo);
    this.#yawOffsetQ = [1, 0, 0, 0];
    this.#lastFrameTs = 0;
  }

  /** Set the Madgwick filter gain. Stored, and applied live when Madgwick is active. */
  setBeta(beta: number): void {
    this.#beta = beta;
    if (this.#filter instanceof MadgwickAHRS) this.#filter.beta = beta;
  }

  /**
   * Set the VQF accel low-pass time constant (seconds). Stored, and applied live
   * when VQF is active.
   */
  setTauAcc(tau: number): void {
    this.#tauAcc = tau;
    if (this.#filter instanceof VqfAHRS) this.#filter.setTauAcc(tau);
  }

  /** Runtime gyro-scale calibration (LSB per deg/s). Ignores non-finite or ≤0 values. */
  setGyroScale(scale: number): void {
    this.#gyroScale = finitePositive(scale, this.#gyroScale);
  }

  /** Per-axis gyro correction (deg/s), subtracted from every sample. Stored as a copy. */
  setGyroBias(bias: Vec3): void {
    this.#gyroBias = copyVec3(bias);
  }

  /** Per-axis accel correction (g), subtracted from every sample. Stored as a copy. */
  setAccelBias(bias: Vec3): void {
    this.#accelBias = copyVec3(bias);
  }

  // --- internal ----------------------------------------------------------------

  /** Start the stream once the transport is connected: send START, begin timers. */
  async #startStreaming(): Promise<void> {
    await this.#transport.writeRx(startCmd(this.#rateHz), true);
    this.#startRateTimer();
    this.#setState("streaming");
  }

  /** Transport callback: decode inbound notification bytes into frames. */
  #ingest = (bytes: Uint8Array): void => {
    for (const frame of this.#parser.push(bytes)) this.#handleFrame(frame);
  };

  /** Transport callback: the link dropped (lost or via {@link disconnect}). */
  #handleTransportDisconnect = (): void => {
    if (this.#state !== "disconnected") this.#cleanup();
  };

  /** Transport callback: a battery-level reading (percent). */
  #handleBattery = (percent: number): void => {
    this.#battery = percent;
    this.emit("battery", percent);
  };

  #handleFrame(raw: RawFrame): void {
    // Scale to physical units, then subtract the per-axis correction (bias) vectors.
    const gx = raw.gxRaw / this.#gyroScale - this.#gyroBias.x;
    const gy = raw.gyRaw / this.#gyroScale - this.#gyroBias.y;
    const gz = raw.gzRaw / this.#gyroScale - this.#gyroBias.z;
    const ax = raw.axRaw / DEFAULT_ACCEL_SCALE - this.#accelBias.x;
    const ay = raw.ayRaw / DEFAULT_ACCEL_SCALE - this.#accelBias.y;
    const az = raw.azRaw / DEFAULT_ACCEL_SCALE - this.#accelBias.z;

    const now = performance.now();
    this.#countFrame(now);

    this.emit("frame", {
      raw: { gx: raw.gxRaw, gy: raw.gyRaw, gz: raw.gzRaw, ax: raw.axRaw, ay: raw.ayRaw, az: raw.azRaw },
      gyro: { x: gx, y: gy, z: gz },
      accel: { x: ax, y: ay, z: az },
      t: now,
    });

    if (this.#filter) {
      // Integrate at the measured frame period (clamped to absorb tab-switch gaps).
      let dt = this.#lastFrameTs ? (now - this.#lastFrameTs) / 1000 : 1 / this.#rateHz;
      this.#lastFrameTs = now;
      if (dt > MAX_DT_S) dt = MAX_DT_S;
      this.#filter.update(gx, gy, gz, ax, ay, az, dt);
      const qd = quatMul(this.#yawOffsetQ, this.#filter.quaternion());
      this.emit("orientation", { quaternion: qd, euler: eulerOf(qd), algorithm: this.#algo, t: now });
    }
  }

  #countFrame(now: number): void {
    this.#frameTimes.push(now);
    while (this.#frameTimes.length && now - this.#frameTimes[0]! > RATE_WINDOW_MS) {
      this.#frameTimes.shift();
    }
  }

  #currentHz(): number {
    return this.#frameTimes.length;
  }

  #startRateTimer(): void {
    this.#stopRateTimer();
    this.#rateTimer = setInterval(() => this.emit("rate", this.#currentHz()), RATE_WINDOW_MS);
  }

  #stopRateTimer(): void {
    if (this.#rateTimer !== undefined) {
      clearInterval(this.#rateTimer);
      this.#rateTimer = undefined;
    }
  }

  #setState(state: ConnectionState): void {
    this.#state = state;
    this.emit("connectionchange", state);
  }

  #cleanup(): void {
    this.#stopRateTimer();
    this.#battery = null;
    this.#parser.reset();
    this.#frameTimes = [];
    this.#lastFrameTs = 0;
    this.#setState("disconnected");
  }
}
