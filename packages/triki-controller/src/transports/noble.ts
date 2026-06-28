/**
 * Node implementation of {@link TrikiTransport}, backed by `@abandonware/noble`.
 *
 * This is a working skeleton: it scans for a TRIKI token by advertised name (or a
 * fixed address), connects, discovers the NUS characteristics, and streams TX
 * notifications back to the {@link TrikiController}. It is intentionally minimal — see
 * the `TODO`s for scan timeouts and richer error handling before production use.
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
import { NUS_SERVICE, NUS_RX, NUS_TX, NUS_CTRL } from "../protocol";
import type { TrikiTransport } from "../transport";

// Node's Buffer, declared locally so this file needs no `@types/node` (noble's writes
// want a Buffer; it is a Uint8Array subclass at runtime).
declare const Buffer: {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
};

/** Options for {@link NobleTransport}. */
export interface NobleTransportOptions {
  /**
   * Match devices whose advertised name starts with this prefix. Default `"TRIKI"`
   * (the token advertises as `TRIKI <serial>`). Ignored when {@link address} is set.
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
  readonly state: string;
  on(event: "stateChange", listener: (state: string) => void): this;
  on(event: "discover", listener: (peripheral: NoblePeripheral) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

/** noble matches UUIDs as lowercase hex without dashes. */
const nobleUuid = (uuid: string): string => uuid.replace(/-/g, "").toLowerCase();
const NUS_SERVICE_ID = nobleUuid(NUS_SERVICE);
const NUS_RX_ID = nobleUuid(NUS_RX);
const NUS_TX_ID = nobleUuid(NUS_TX);
const NUS_CTRL_ID = nobleUuid(NUS_CTRL);
/** Standard Battery Service (0x180F) and Battery Level characteristic (0x2A19). */
const BATTERY_SERVICE_ID = "180f";
const BATTERY_LEVEL_ID = "2a19";

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

export class NobleTransport implements TrikiTransport {
  #namePrefix: string;
  #address: string | null;
  #injectedNoble: Noble | null;
  #peripheral: NoblePeripheral | null = null;
  #rxChar: NobleCharacteristic | null = null;
  #txChar: NobleCharacteristic | null = null;
  #ctrlChar: NobleCharacteristic | null = null;
  #frameHandler: ((bytes: Uint8Array) => void) | null = null;
  #disconnectHandler: (() => void) | null = null;
  #batteryHandler: ((percent: number) => void) | null = null;

  constructor(options: NobleTransportOptions = {}) {
    this.#namePrefix = options.namePrefix ?? "TRIKI";
    this.#address = options.address ? options.address.toLowerCase() : null;
    this.#injectedNoble = (options.noble as Noble | undefined) ?? null;
  }

  get hasLed(): boolean {
    return this.#ctrlChar !== null;
  }

  onFrame(handler: (bytes: Uint8Array) => void): void {
    this.#frameHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.#disconnectHandler = handler;
  }

  onBattery(handler: (percent: number) => void): void {
    this.#batteryHandler = handler;
  }

  async connect(): Promise<void> {
    const noble = this.#injectedNoble ?? (await loadNoble());
    try {
      await this.#waitPoweredOn(noble);
      const peripheral = await this.#scan(noble);
      this.#peripheral = peripheral;
      peripheral.once("disconnect", this.#onDisconnected);
      await peripheral.connectAsync();

      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [NUS_SERVICE_ID],
        [NUS_RX_ID, NUS_TX_ID, NUS_CTRL_ID],
      );
      this.#rxChar = characteristics.find((c) => c.uuid === NUS_RX_ID) ?? null;
      this.#txChar = characteristics.find((c) => c.uuid === NUS_TX_ID) ?? null;
      this.#ctrlChar = characteristics.find((c) => c.uuid === NUS_CTRL_ID) ?? null;
      if (!this.#rxChar || !this.#txChar) {
        throw new Error("Triki NUS RX/TX characteristics not found on the device.");
      }

      this.#txChar.on("data", (data) => this.#frameHandler?.(data));
      await this.#txChar.subscribeAsync();

      await this.#startBattery(peripheral); // best-effort; never blocks streaming
    } catch (err) {
      this.#teardown();
      throw err;
    }
  }

  /** Read the Battery service once and subscribe to updates, if the device exposes it. */
  async #startBattery(peripheral: NoblePeripheral): Promise<void> {
    try {
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [BATTERY_SERVICE_ID],
        [BATTERY_LEVEL_ID],
      );
      const batt = characteristics.find((c) => c.uuid === BATTERY_LEVEL_ID);
      if (!batt) return;
      const value = await batt.readAsync();
      if (value.length) this.#batteryHandler?.(value[0]!);
      batt.on("data", (data) => {
        if (data.length) this.#batteryHandler?.(data[0]!);
      });
      await batt.subscribeAsync();
    } catch {
      /* no Battery service, or notifications unsupported — the read (if any) stands */
    }
  }

  /** Re-scan and connect again (skeleton: same as a fresh connect). */
  async reconnect(): Promise<void> {
    await this.connect();
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
    const peripheral = this.#peripheral;
    if (peripheral) void peripheral.disconnectAsync();
    else this.#onDisconnected();
  }

  // --- internal ----------------------------------------------------------------

  #waitPoweredOn(noble: Noble): Promise<void> {
    if (noble.state === "poweredOn") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onState = (state: string): void => {
        if (state === "poweredOn") {
          noble.removeListener("stateChange", onState);
          resolve();
        } else if (state === "unsupported" || state === "unauthorized") {
          noble.removeListener("stateChange", onState);
          reject(new Error(`Bluetooth adapter is ${state}.`));
        }
      };
      noble.on("stateChange", onState);
    });
  }

  #scan(noble: Noble): Promise<NoblePeripheral> {
    return new Promise<NoblePeripheral>((resolve, reject) => {
      const onDiscover = (peripheral: NoblePeripheral): void => {
        if (!this.#matches(peripheral)) return;
        noble.removeListener("discover", onDiscover);
        void noble.stopScanningAsync();
        resolve(peripheral);
      };
      noble.on("discover", onDiscover);
      // TODO: add a scan timeout that removes the listener and rejects.
      noble.startScanningAsync([], false).catch(reject);
    });
  }

  #matches(peripheral: NoblePeripheral): boolean {
    if (this.#address) return peripheral.address?.toLowerCase() === this.#address;
    const name = peripheral.advertisement?.localName ?? "";
    return name.toLowerCase().startsWith(this.#namePrefix.toLowerCase());
  }

  #onDisconnected = (): void => {
    this.#teardown();
    this.#disconnectHandler?.();
  };

  #teardown(): void {
    this.#peripheral?.removeAllListeners("disconnect");
    this.#rxChar = null;
    this.#txChar = null;
    this.#ctrlChar = null;
    this.#peripheral = null;
  }
}

/** noble's writes want a Node Buffer; build one without leaking Buffer into the API. */
function toBuffer(data: Uint8Array): Uint8Array {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
