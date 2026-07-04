/**
 * Node implementation of {@link TrikiTransport}, backed by `@abandonware/noble`.
 *
 * Lifecycle guarantees (the {@link TrikiTransport} contract):
 * - `connect()` scans for a TRIKI token by advertised name (or a fixed address),
 *   connects, discovers the NUS + Battery characteristics in one GATT round trip, and
 *   subscribes to TX notifications. The whole attempt shares one time budget
 *   ({@link NobleTransportOptions.scanTimeoutMs}, default 15 s) and rejects with
 *   {@link ScanTimeoutError} when it runs out.
 * - `disconnect()` is idempotent: it cancels a pending `connect()` (which then rejects
 *   with {@link ConnectAbortedError}), tears down an active session (firing
 *   `onDisconnect` exactly once), and is a no-op otherwise.
 * - `reconnect()` re-links to the exact peripheral of the previous successful
 *   `connect()` — no scan, so it can never latch onto a different token — and throws
 *   when there is nothing to reconnect to.
 * - The battery read/subscribe is fire-and-forget: it never delays `connect()` or the
 *   controller's START command.
 *
 * `@abandonware/noble` is an **optional peer dependency**: it is imported lazily and
 * only required when {@link NobleTransport.connect} runs, so importing
 * `triki-controller/node` never forces the native module to be installed. Install it to
 * use this transport:
 *
 * ```sh
 * npm install @abandonware/noble
 * ```
 */
import { NUS_SERVICE, NUS_RX, NUS_TX, NUS_CTRL, BATTERY_SERVICE, BATTERY_LEVEL, DEVICE_NAME_PREFIX } from "../protocol";
import type { TrikiTransport, TrikiTransportHandlers } from "../transport";

// Node's Buffer, declared locally so this file needs no `@types/node` (noble's writes
// want a Buffer; it is a Uint8Array subclass at runtime).
declare const Buffer: {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
};

/** The connect()/scan budget ran out before a device was streaming. */
export class ScanTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanTimeoutError";
  }
}

/** disconnect() was called while a connect()/reconnect() was still pending. */
export class ConnectAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectAbortedError";
  }
}

/** Default budget for adapter power-on + scan + link setup, in milliseconds. */
const DEFAULT_SCAN_TIMEOUT_MS = 15_000;

/** Options for {@link NobleTransport}. */
export interface NobleTransportOptions {
  /**
   * Match devices whose advertised name starts with this prefix (case-insensitive).
   * Default `"TRIKI"` (the token advertises as `TRIKI <serial>`). Ignored when
   * {@link address} is set.
   */
  namePrefix?: string;
  /** Match a specific device by BLE address (case-insensitive) instead of by name. */
  address?: string;
  /**
   * A noble-API-compatible module to use instead of lazily importing
   * `@abandonware/noble`. Pass e.g. `import noble from "@stoprocent/noble"` when the
   * default fork won't build on your Node version, or a mock for tests.
   */
  noble?: unknown;
  /**
   * Time budget in milliseconds for the whole connect attempt: adapter power-on, the
   * scan, and link setup (reconnect shares the same budget). Default 15 000. Pass
   * `Infinity` to wait forever (cancel via `disconnect()`).
   */
  scanTimeoutMs?: number;
  /**
   * Advertised-service filter passed to noble's `startScanningAsync`. Default `[]`
   * (scan everything): it is unverified whether Triki tokens include the 128-bit NUS
   * UUID in their advertisement (the `TRIKI <serial>` name may crowd it out of the
   * ADV packet), so filtering by default could find nothing. Pass `[NUS_SERVICE]` to
   * opt in; UUIDs are normalized via {@link nobleUuid}.
   */
  scanServiceUuids?: string[];
}

// --- minimal slice of the @abandonware/noble surface we use ----------------------
// Declared locally so `typecheck`/`build` need no noble install (it is lazily imported
// and externalized at build time). Buffers are Uint8Arrays, so we type them as such.

interface NobleCharacteristic {
  readonly uuid: string;
  writeAsync(data: Uint8Array, withoutResponse: boolean): Promise<void>;
  readAsync(): Promise<Uint8Array>;
  subscribeAsync(): Promise<void>;
  on(event: "data", listener: (data: Uint8Array, isNotification: boolean) => void): this;
}

interface NoblePeripheral {
  /** Stable device id. noble caches Peripheral objects by id, and a cached peripheral
   *  supports `connectAsync()` again after `disconnectAsync()` — reconnect relies on it. */
  readonly id: string;
  readonly address: string;
  readonly advertisement: { localName?: string };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverSomeServicesAndCharacteristicsAsync(
    serviceUuids: string[],
    characteristicUuids: string[],
  ): Promise<{ characteristics: NobleCharacteristic[] }>;
  once(event: "disconnect", listener: () => void): this;
  removeAllListeners(event?: string): this;
}

interface Noble {
  /** May already be terminal ('unsupported'/'unauthorized') before any listener
   *  attaches; 'stateChange' fires once per transition and never replays, so always
   *  check `state` synchronously first. */
  readonly state: string;
  on(event: "stateChange", listener: (state: string) => void): this;
  on(event: "discover", listener: (peripheral: NoblePeripheral) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

const BLUETOOTH_BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/**
 * Convert a canonical UUID to noble's representation: 16-bit-assigned UUIDs on the
 * Bluetooth base are reported short ("180f"), everything else lowercase and dashless.
 */
export const nobleUuid = (uuid: string): string => {
  const u = uuid.toLowerCase();
  if (u.startsWith("0000") && u.endsWith(BLUETOOTH_BASE_SUFFIX)) return u.slice(4, 8);
  return u.replace(/-/g, "");
};

const NUS_SERVICE_ID = nobleUuid(NUS_SERVICE);
const NUS_RX_ID = nobleUuid(NUS_RX);
const NUS_TX_ID = nobleUuid(NUS_TX);
const NUS_CTRL_ID = nobleUuid(NUS_CTRL);
const BATTERY_SERVICE_ID = nobleUuid(BATTERY_SERVICE);
const BATTERY_LEVEL_ID = nobleUuid(BATTERY_LEVEL);

async function loadNoble(): Promise<Noble> {
  try {
    // Non-literal specifier: keeps `tsc` from resolving the optional module at
    // typecheck time and keeps the bundler from inlining it (also marked external).
    const specifier: string = "@abandonware/noble";
    const mod: { default?: Noble } & Noble = await import(specifier);
    return mod.default ?? mod;
  } catch (err) {
    // ES2020 lib has no Error `cause` option; attach it manually for debuggability.
    const error = new Error(
      "NobleTransport requires the optional peer dependency '@abandonware/noble'. " +
        "Install it with: npm install @abandonware/noble",
    );
    (error as { cause?: unknown }).cause = err;
    throw error;
  }
}

/** Bookkeeping for one in-flight connect()/reconnect(). */
interface ConnectAttempt {
  cancelled: boolean;
  /** Rejecter of whichever cancellable wait is pending; disconnect() invokes it. */
  fail: ((err: Error) => void) | null;
}

export class NobleTransport implements TrikiTransport {
  #namePrefixLower: string;
  #address: string | null;
  #injectedNoble: Noble | null;
  #scanTimeoutMs: number;
  #scanServiceUuids: string[];

  #noble: Noble | null = null; // lazily-loaded module, cached across sessions
  #handlers: TrikiTransportHandlers | null = null;
  #attempt: ConnectAttempt | null = null;
  /** True only between connect()/reconnect() resolving and the next teardown. */
  #sessionActive = false;
  #peripheral: NoblePeripheral | null = null;
  #rxChar: NobleCharacteristic | null = null;
  #txChar: NobleCharacteristic | null = null;
  #ctrlChar: NobleCharacteristic | null = null;
  /** Retained across teardown so reconnect() can re-link without a scan. */
  #lastPeripheral: NoblePeripheral | null = null;

  constructor(options: NobleTransportOptions = {}) {
    this.#namePrefixLower = (options.namePrefix ?? DEVICE_NAME_PREFIX).toLowerCase();
    this.#address = options.address ? options.address.toLowerCase() : null;
    this.#injectedNoble = (options.noble as Noble | undefined) ?? null;
    const t = options.scanTimeoutMs;
    this.#scanTimeoutMs =
      typeof t === "number" && ((Number.isFinite(t) && t > 0) || t === Infinity)
        ? t
        : DEFAULT_SCAN_TIMEOUT_MS;
    this.#scanServiceUuids = (options.scanServiceUuids ?? []).map(nobleUuid);
  }

  get hasLed(): boolean {
    return this.#ctrlChar !== null;
  }

  attach(handlers: TrikiTransportHandlers): void {
    if (this.#handlers) throw new Error("NobleTransport is already attached.");
    this.#handlers = handlers;
  }

  detach(): void {
    this.#handlers = null;
  }

  /** Synchronous pre-flight: reconnect needs a remembered device. */
  preflight(op: "connect" | "reconnect"): void {
    if (op === "reconnect" && !this.#lastPeripheral) {
      throw new Error("No device to reconnect to; call connect() first.");
    }
  }

  async connect(): Promise<void> {
    const { noble, attempt, deadline } = await this.#beginAttempt();
    try {
      await this.#waitPoweredOn(noble, attempt, deadline);
      this.#checkCancelled(attempt);
      const peripheral = await this.#scan(noble, attempt, deadline);
      this.#checkCancelled(attempt);
      // Cached as soon as the scan matches, so reconnect() works even when the rest
      // of this attempt fails (mirrors the web transport retaining its #device).
      this.#lastPeripheral = peripheral;
      await this.#openSession(peripheral, attempt, deadline);
    } catch (err) {
      this.#abortAttempt();
      throw err;
    } finally {
      this.#attempt = null;
    }
  }

  /** Re-link to the peripheral of the previous successful connect() — no scan. */
  async reconnect(): Promise<void> {
    this.preflight("reconnect");
    const peripheral = this.#lastPeripheral!;
    const { noble, attempt, deadline } = await this.#beginAttempt();
    try {
      await this.#waitPoweredOn(noble, attempt, deadline);
      this.#checkCancelled(attempt);
      await this.#openSession(peripheral, attempt, deadline);
    } catch (err) {
      this.#abortAttempt();
      throw err;
    } finally {
      this.#attempt = null;
    }
  }

  async writeRx(data: Uint8Array, withoutResponse = false): Promise<void> {
    if (!this.#rxChar) throw new Error("Not connected.");
    await this.#rxChar.writeAsync(toBuffer(data), withoutResponse);
  }

  async writeCtrl(data: Uint8Array): Promise<void> {
    if (!this.#ctrlChar) throw new Error("LED control characteristic is not available.");
    await this.#ctrlChar.writeAsync(toBuffer(data), false);
  }

  disconnect(): void {
    const attempt = this.#attempt;
    if (attempt) {
      // Cancel the pending connect: reject the cancellable wait (scan / power-on) or
      // let the next checkpoint throw; drop a half-connected peripheral so pending
      // GATT awaits settle. No onDisconnect — the connect() rejection is the signal.
      attempt.cancelled = true;
      attempt.fail?.(new ConnectAbortedError("Disconnected while connecting."));
      const peripheral = this.#peripheral;
      if (peripheral) void peripheral.disconnectAsync().catch(() => {});
      return;
    }
    if (!this.#sessionActive) return; // idempotent; never connected -> no onDisconnect
    const peripheral = this.#peripheral!;
    this.#finishSession();
    void peripheral.disconnectAsync().catch(() => {});
  }

  // --- internal ----------------------------------------------------------------

  /** Shared connect/reconnect entry: guards, module load, attempt bookkeeping. */
  async #beginAttempt(): Promise<{ noble: Noble; attempt: ConnectAttempt; deadline: number }> {
    if (this.#attempt) throw new Error("connect() is already in progress.");
    if (this.#sessionActive) throw new Error("Already connected.");
    const attempt: ConnectAttempt = { cancelled: false, fail: null };
    this.#attempt = attempt;
    const deadline = Number.isFinite(this.#scanTimeoutMs)
      ? Date.now() + this.#scanTimeoutMs
      : Infinity;
    try {
      const noble = this.#injectedNoble ?? (this.#noble ??= await loadNoble());
      this.#checkCancelled(attempt);
      return { noble, attempt, deadline };
    } catch (err) {
      this.#attempt = null;
      throw err;
    }
  }

  #checkCancelled(attempt: ConnectAttempt): void {
    if (attempt.cancelled) throw new ConnectAbortedError("Disconnected while connecting.");
  }

  /** Failure path of an attempt: drop any half-open link, reset session state. */
  #abortAttempt(): void {
    const peripheral = this.#peripheral;
    if (peripheral) void peripheral.disconnectAsync().catch(() => {});
    this.#teardown();
  }

  /**
   * Resolve when the adapter is powered on. Terminal states are checked
   * synchronously — noble emits `stateChange` once per transition and never replays
   * it, so waiting for an event that already happened would hang forever.
   */
  #waitPoweredOn(noble: Noble, attempt: ConnectAttempt, deadline: number): Promise<void> {
    if (noble.state === "poweredOn") return Promise.resolve();
    if (noble.state === "unsupported" || noble.state === "unauthorized") {
      return Promise.reject(new Error(`Bluetooth adapter is ${noble.state}.`));
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        noble.removeListener("stateChange", onState);
        if (timer !== undefined) clearTimeout(timer);
        attempt.fail = null;
      };
      const onState = (state: string): void => {
        if (state === "poweredOn") {
          cleanup();
          resolve();
        } else if (state === "unsupported" || state === "unauthorized") {
          cleanup();
          reject(new Error(`Bluetooth adapter is ${state}.`));
        }
      };
      attempt.fail = (err) => {
        cleanup();
        reject(err);
      };
      const remaining = deadline - Date.now();
      if (Number.isFinite(remaining)) {
        timer = setTimeout(() => {
          cleanup();
          reject(
            new ScanTimeoutError(
              `Bluetooth adapter did not power on within ${this.#scanTimeoutMs}ms ` +
                `(state: ${noble.state}).`,
            ),
          );
        }, Math.max(0, remaining));
      }
      noble.on("stateChange", onState);
    });
  }

  /**
   * Scan until a matching peripheral appears. Every exit — match, timeout, cancel,
   * or a startScanning failure — removes the `discover` listener and stops scanning,
   * so retried connects never stack listeners on the (module-level) noble emitter.
   */
  #scan(noble: Noble, attempt: ConnectAttempt, deadline: number): Promise<NoblePeripheral> {
    return new Promise<NoblePeripheral>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        noble.removeListener("discover", onDiscover);
        if (timer !== undefined) clearTimeout(timer);
        attempt.fail = null;
        void noble.stopScanningAsync().catch(() => {});
      };
      const onDiscover = (peripheral: NoblePeripheral): void => {
        if (!this.#matches(peripheral)) return;
        cleanup();
        resolve(peripheral);
      };
      attempt.fail = (err) => {
        cleanup();
        reject(err);
      };
      const remaining = deadline - Date.now();
      if (Number.isFinite(remaining)) {
        timer = setTimeout(() => {
          cleanup();
          const target = this.#address
            ? `address "${this.#address}"`
            : `name prefix "${this.#namePrefixLower.toUpperCase()}"`;
          reject(
            new ScanTimeoutError(
              `No device matching ${target} found within ${this.#scanTimeoutMs}ms of scanning.`,
            ),
          );
        }, Math.max(0, remaining));
      }
      noble.on("discover", onDiscover);
      noble.startScanningAsync(this.#scanServiceUuids, false).catch((err) => {
        if (!settled) {
          cleanup();
          reject(err);
        }
      });
    });
  }

  /** Connect + discover + subscribe on a known peripheral. Shared by (re)connect. */
  async #openSession(
    peripheral: NoblePeripheral,
    attempt: ConnectAttempt,
    deadline: number,
  ): Promise<void> {
    this.#peripheral = peripheral;
    peripheral.once("disconnect", this.#onPeripheralDisconnect);

    await this.#race(peripheral.connectAsync(), attempt, deadline, "Connecting to the device");
    this.#checkCancelled(attempt);

    // One combined GATT discovery for NUS + Battery: a second discovery procedure
    // would double the connect-time round trips. Battery absence just means find()
    // comes back empty.
    const { characteristics } = await this.#race(
      peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [NUS_SERVICE_ID, BATTERY_SERVICE_ID],
        [NUS_RX_ID, NUS_TX_ID, NUS_CTRL_ID, BATTERY_LEVEL_ID],
      ),
      attempt,
      deadline,
      "Service discovery",
    );
    this.#checkCancelled(attempt);
    this.#rxChar = characteristics.find((c) => c.uuid === NUS_RX_ID) ?? null;
    this.#txChar = characteristics.find((c) => c.uuid === NUS_TX_ID) ?? null;
    this.#ctrlChar = characteristics.find((c) => c.uuid === NUS_CTRL_ID) ?? null;
    const battChar = characteristics.find((c) => c.uuid === BATTERY_LEVEL_ID) ?? null;
    if (!this.#rxChar || !this.#txChar) {
      throw new Error("Triki NUS RX/TX characteristics not found on the device.");
    }

    this.#txChar.on("data", (data) => this.#handlers?.onFrame(data));
    await this.#race(this.#txChar.subscribeAsync(), attempt, deadline, "TX subscription");
    this.#checkCancelled(attempt);

    this.#sessionActive = true;
    // Fire-and-forget: battery must never delay connect() or the START command.
    void this.#startBattery(battChar, peripheral);
  }

  /**
   * Read the battery level once and subscribe to updates. Best-effort and detached
   * from connect(); the per-session guards keep a stale read from leaking into a
   * torn-down or replaced session.
   */
  async #startBattery(batt: NobleCharacteristic | null, peripheral: NoblePeripheral): Promise<void> {
    if (!batt) return;
    try {
      const value = await batt.readAsync();
      if (this.#peripheral !== peripheral || !this.#sessionActive) return;
      if (value.length) this.#handlers?.onBattery(value[0]!);
      batt.on("data", (data) => {
        if (data.length && this.#peripheral === peripheral && this.#sessionActive) {
          this.#handlers?.onBattery(data[0]!);
        }
      });
      await batt.subscribeAsync();
    } catch {
      /* no Battery service, or notifications unsupported — the read (if any) stands */
    }
  }

  /** Race a GATT promise against the attempt's cancel hook and the shared deadline. */
  #race<T>(work: Promise<T>, attempt: ConnectAttempt, deadline: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        attempt.fail = null;
        fn();
      };
      attempt.fail = (err) => settle(() => reject(err));
      const remaining = deadline - Date.now();
      if (Number.isFinite(remaining)) {
        timer = setTimeout(
          () => settle(() => reject(new ScanTimeoutError(`${what} timed out after ${this.#scanTimeoutMs}ms.`))),
          Math.max(0, remaining),
        );
      }
      work.then(
        (value) => settle(() => resolve(value)),
        (err) => settle(() => reject(err)),
      );
    });
  }

  #matches(peripheral: NoblePeripheral): boolean {
    if (this.#address) return peripheral.address?.toLowerCase() === this.#address;
    const name = peripheral.advertisement?.localName ?? "";
    return name.toLowerCase().startsWith(this.#namePrefixLower);
  }

  /** Remote link drop. Explicit disconnect() runs #finishSession itself first. */
  #onPeripheralDisconnect = (): void => {
    if (this.#sessionActive) this.#finishSession();
  };

  /** Tear the active session down and fire onDisconnect — structurally exactly once:
   *  #teardown removes the peripheral's disconnect listener before the handler runs. */
  #finishSession(): void {
    this.#sessionActive = false;
    this.#teardown();
    this.#handlers?.onDisconnect();
  }

  #teardown(): void {
    this.#sessionActive = false;
    this.#peripheral?.removeAllListeners("disconnect");
    // Characteristic 'data' listeners are intentionally not removed: noble builds
    // fresh Characteristic instances on every discovery, so old listeners die with
    // the old objects.
    this.#rxChar = null;
    this.#txChar = null;
    this.#ctrlChar = null;
    this.#peripheral = null;
    // #lastPeripheral is retained so reconnect() can re-link without a scan.
  }
}

/** noble's writes want a Node Buffer; build one without leaking Buffer into the API. */
function toBuffer(data: Uint8Array): Uint8Array {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
