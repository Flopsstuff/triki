/**
 * Web Bluetooth client for the Żabka Triki BLE token. Connects over the Nordic
 * UART Service, starts the IMU stream, parses motion frames, and (optionally) fuses
 * orientation with a 6-axis Madgwick filter. This is the only module that touches
 * `navigator.bluetooth` and `performance`.
 */
import { TypedEmitter } from "./emitter";
import { FrameParser } from "./parser";
import type { RawFrame } from "./parser";
import { MadgwickAHRS, quatMul, quatAboutZ, yawRadOf, eulerOf } from "./fusion";
import type { Quaternion } from "./fusion";
import {
  NUS_SERVICE,
  NUS_RX,
  NUS_TX,
  NUS_CTRL,
  BATTERY_SERVICE,
  DEFAULT_ACCEL_SCALE,
  DEFAULT_GYRO_SCALE,
  DEFAULT_RATE_HZ,
  DEFAULT_BETA,
  startCmd,
  ledCmd,
} from "./protocol";
import type { ConnectionState, TrikiControllerOptions, TrikiEventMap } from "./events";

const RATE_WINDOW_MS = 1000;
const MAX_DT_S = 0.2;

export class TrikiController extends TypedEmitter<TrikiEventMap> {
  #device: BluetoothDevice | null = null;
  #gatt: BluetoothRemoteGATTServer | null = null;
  #rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  #txChar: BluetoothRemoteGATTCharacteristic | null = null;
  #ctrlChar: BluetoothRemoteGATTCharacteristic | null = null;

  #parser = new FrameParser();
  #madgwick: MadgwickAHRS | null;
  #fusion: boolean;
  #state: ConnectionState = "disconnected";
  #rateHz: number;
  #gyroScale: number;
  #yawOffsetQ: Quaternion = [1, 0, 0, 0];
  #lastFrameTs = 0;
  #frameTimes: number[] = [];
  #rateTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TrikiControllerOptions = {}) {
    super();
    this.#fusion = options.fusion ?? true;
    this.#rateHz = options.rateHz ?? DEFAULT_RATE_HZ;
    this.#gyroScale = options.gyroScale ?? DEFAULT_GYRO_SCALE;
    this.#madgwick = this.#fusion ? new MadgwickAHRS({ beta: options.beta ?? DEFAULT_BETA }) : null;
  }

  /** True when Web Bluetooth is available (safe to call during SSR). */
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
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
    return this.#ctrlChar !== null;
  }

  /** The Madgwick filter, or `undefined` when fusion is disabled. */
  get fusion(): MadgwickAHRS | undefined {
    return this.#madgwick ?? undefined;
  }

  /**
   * Show the browser device picker, connect, and start the IMU stream.
   * Must be called from a user gesture (e.g. a click handler). Rejects (after
   * cleaning up) if pairing or the handshake fails.
   */
  async connect(): Promise<void> {
    if (!TrikiController.isSupported()) {
      throw new Error("Web Bluetooth is not available in this environment.");
    }
    if (this.#state !== "disconnected") return;
    try {
      this.#setState("pairing");
      this.#device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "TRIKI" }, { namePrefix: "Triki" }],
        optionalServices: [NUS_SERVICE, BATTERY_SERVICE],
      });
      await this.#startSession();
    } catch (err) {
      this.#cleanup();
      throw err;
    }
  }

  /**
   * Reconnect to the previously paired device without showing the picker.
   * Throws if {@link connect} was never called.
   */
  async reconnect(): Promise<void> {
    if (!this.#device) throw new Error("No device to reconnect to; call connect() first.");
    if (this.#state !== "disconnected") return;
    try {
      this.#setState("pairing");
      await this.#startSession();
    } catch (err) {
      this.#cleanup();
      throw err;
    }
  }

  /** Disconnect from the token. Triggers a `connectionchange` to `disconnected`. */
  disconnect(): void {
    if (this.#gatt && this.#gatt.connected) this.#gatt.disconnect();
    else this.#onDisconnected();
  }

  /** Turn the green LED on or off. Throws when the LED characteristic is unavailable. */
  async setLed(on: boolean): Promise<void> {
    if (!this.#ctrlChar) throw new Error("LED control characteristic is not available.");
    await this.#ctrlChar.writeValue(ledCmd(on));
  }

  /**
   * Set the IMU sample rate (Hz). Applies immediately when streaming (re-sends the
   * START command), otherwise takes effect on the next {@link connect}.
   */
  async setRate(hz: number): Promise<void> {
    this.#rateHz = hz;
    if (this.#rxChar) await this.#write(this.#rxChar, startCmd(hz), true);
  }

  /** Re-zero the heading (yaw). No-op when fusion is disabled. Tilt stays absolute. */
  resetHeading(): void {
    if (!this.#madgwick) return;
    this.#yawOffsetQ = quatAboutZ(-yawRadOf(this.#madgwick.quaternion()));
  }

  /** Runtime gyro-scale calibration (LSB per deg/s). */
  setGyroScale(scale: number): void {
    this.#gyroScale = scale;
  }

  // --- internal ----------------------------------------------------------------

  async #startSession(): Promise<void> {
    const device = this.#device;
    if (!device || !device.gatt) throw new Error("Device GATT is not available.");
    // Same listener reference, so re-adding on reconnect is a no-op.
    device.addEventListener("gattserverdisconnected", this.#onDisconnected);

    this.#gatt = await device.gatt.connect();
    const svc = await this.#gatt.getPrimaryService(NUS_SERVICE);
    this.#rxChar = await svc.getCharacteristic(NUS_RX);
    this.#txChar = await svc.getCharacteristic(NUS_TX);
    try {
      this.#ctrlChar = await svc.getCharacteristic(NUS_CTRL);
    } catch {
      this.#ctrlChar = null;
    }

    await this.#txChar.startNotifications();
    this.#txChar.addEventListener("characteristicvaluechanged", this.#onNotify);

    await this.#write(this.#rxChar, startCmd(this.#rateHz), true);

    this.#startRateTimer();
    this.#setState("streaming");
  }

  #onNotify = (event: Event): void => {
    const char = event.target as BluetoothRemoteGATTCharacteristic;
    const view = char.value;
    if (!view) return;
    // byteOffset/byteLength are load-bearing: the underlying buffer may be larger.
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (const frame of this.#parser.push(bytes)) this.#handleFrame(frame);
  };

  #onDisconnected = (): void => {
    this.#cleanup();
  };

  #handleFrame(raw: RawFrame): void {
    const gx = raw.gxRaw / this.#gyroScale;
    const gy = raw.gyRaw / this.#gyroScale;
    const gz = raw.gzRaw / this.#gyroScale;
    const ax = raw.axRaw / DEFAULT_ACCEL_SCALE;
    const ay = raw.ayRaw / DEFAULT_ACCEL_SCALE;
    const az = raw.azRaw / DEFAULT_ACCEL_SCALE;

    const now = performance.now();
    this.#countFrame(now);

    this.emit("frame", {
      raw: { gx: raw.gxRaw, gy: raw.gyRaw, gz: raw.gzRaw, ax: raw.axRaw, ay: raw.ayRaw, az: raw.azRaw },
      gyro: { x: gx, y: gy, z: gz },
      accel: { x: ax, y: ay, z: az },
      t: now,
    });

    if (this.#madgwick) {
      // Integrate at the measured frame period (clamped to absorb tab-switch gaps).
      let dt = this.#lastFrameTs ? (now - this.#lastFrameTs) / 1000 : 1 / this.#rateHz;
      this.#lastFrameTs = now;
      if (dt > MAX_DT_S) dt = MAX_DT_S;
      this.#madgwick.update(gx, gy, gz, ax, ay, az, dt);
      const qd = quatMul(this.#yawOffsetQ, this.#madgwick.quaternion());
      this.emit("orientation", { quaternion: qd, euler: eulerOf(qd), t: now });
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
    if (this.#txChar) {
      try {
        this.#txChar.removeEventListener("characteristicvaluechanged", this.#onNotify);
      } catch {
        /* ignore */
      }
    }
    if (this.#device) {
      try {
        this.#device.removeEventListener("gattserverdisconnected", this.#onDisconnected);
      } catch {
        /* ignore */
      }
    }
    this.#stopRateTimer();
    this.#rxChar = null;
    this.#txChar = null;
    this.#ctrlChar = null;
    this.#gatt = null;
    // #device is retained so reconnect() can reuse it without the picker.
    this.#parser.reset();
    this.#frameTimes = [];
    this.#lastFrameTs = 0;
    this.#setState("disconnected");
  }

  async #write(
    char: BluetoothRemoteGATTCharacteristic,
    data: Uint8Array<ArrayBuffer>,
    withoutResponse: boolean,
  ): Promise<void> {
    if (withoutResponse && typeof char.writeValueWithoutResponse === "function") {
      await char.writeValueWithoutResponse(data);
    } else {
      await char.writeValue(data);
    }
  }
}
