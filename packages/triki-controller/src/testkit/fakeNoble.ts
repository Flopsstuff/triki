/**
 * An in-memory mock of the @abandonware/noble surface {@link NobleTransport} uses,
 * injected via its `noble` option. Faithful to the real module where it matters for
 * the transport's correctness:
 * - `stateChange` fires once per transition and is never replayed to late listeners;
 * - every service discovery builds FRESH characteristic objects (so listeners on old
 *   instances die with them);
 * - `disconnectAsync()` emits `disconnect` asynchronously (a microtask later).
 */
import { NUS_SERVICE, NUS_RX, NUS_TX, NUS_CTRL, BATTERY_SERVICE, BATTERY_LEVEL } from "../protocol";
import { nobleUuid } from "../transports/noble";

const RX_ID = nobleUuid(NUS_RX);
const TX_ID = nobleUuid(NUS_TX);
const CTRL_ID = nobleUuid(NUS_CTRL);
const BATTERY_ID = nobleUuid(BATTERY_LEVEL);
const NUS_ID = nobleUuid(NUS_SERVICE);
const BATTERY_SVC_ID = nobleUuid(BATTERY_SERVICE);

/** Microtask hop that survives vi.useFakeTimers (promises are never faked). */
const microtask = (): Promise<void> => Promise.resolve();

export class FakeNobleCharacteristic {
  readonly uuid: string;
  writes: { data: Uint8Array; withoutResponse: boolean }[] = [];
  subscribeCount = 0;
  readValue: Uint8Array;
  /** Test hooks: gate/fail the next readAsync/subscribeAsync/writeAsync. */
  readGate: Promise<void> | null = null;
  readError: Error | null = null;
  subscribeError: Error | null = null;
  writeGate: Promise<void> | null = null;

  #dataListeners = new Set<(data: Uint8Array, isNotification: boolean) => void>();

  constructor(uuid: string, readValue: Uint8Array = new Uint8Array()) {
    this.uuid = uuid;
    this.readValue = readValue;
  }

  async writeAsync(data: Uint8Array, withoutResponse: boolean): Promise<void> {
    if (this.writeGate) await this.writeGate;
    this.writes.push({ data, withoutResponse });
  }

  async readAsync(): Promise<Uint8Array> {
    if (this.readGate) await this.readGate;
    if (this.readError) throw this.readError;
    return this.readValue;
  }

  async subscribeAsync(): Promise<void> {
    if (this.subscribeError) throw this.subscribeError;
    this.subscribeCount++;
  }

  on(event: "data", listener: (data: Uint8Array, isNotification: boolean) => void): this {
    if (event === "data") this.#dataListeners.add(listener);
    return this;
  }

  // --- test drivers ---
  emitData(bytes: Uint8Array): void {
    for (const l of [...this.#dataListeners]) l(bytes, true);
  }

  dataListenerCount(): number {
    return this.#dataListeners.size;
  }
}

export interface FakePeripheralOptions {
  id?: string;
  name?: string;
  address?: string;
  led?: boolean;
  /** Expose the standard Battery service. Default true. */
  battery?: boolean;
  batteryLevel?: number;
  /** Omit the NUS RX/TX characteristics entirely (a non-Triki device). */
  nus?: boolean;
}

export class FakeNoblePeripheral {
  readonly id: string;
  readonly address: string;
  readonly advertisement: { localName?: string };

  connectCount = 0;
  disconnectAsyncCount = 0;
  discoverCalls: { serviceUuids: string[]; characteristicUuids: string[] }[] = [];
  /** Shared operation-order log (wired to FakeNoble.log by makeFakeNoble). */
  log: string[] = [];

  /** Test hooks applied to the next operation / next discovery's fresh chars. */
  connectGate: Promise<void> | null = null;
  connectError: Error | null = null;
  disconnectError: Error | null = null;
  discoverError: Error | null = null;
  txSubscribeError: Error | null = null;
  batteryReadGate: Promise<void> | null = null;

  /** Most recently discovered instances (fresh per discovery, like real noble). */
  rx: FakeNobleCharacteristic | null = null;
  tx: FakeNobleCharacteristic | null = null;
  ctrl: FakeNobleCharacteristic | null = null;
  battery: FakeNobleCharacteristic | null = null;

  #led: boolean;
  #hasBattery: boolean;
  #batteryLevel: number;
  #hasNus: boolean;
  #disconnectListeners = new Set<() => void>();

  constructor(options: FakePeripheralOptions = {}) {
    this.id = options.id ?? "fake-id-1";
    this.address = options.address ?? "aa:bb:cc:dd:ee:ff";
    this.advertisement = { localName: options.name ?? "TRIKI 1234" };
    this.#led = options.led ?? true;
    this.#hasBattery = options.battery ?? true;
    this.#batteryLevel = options.batteryLevel ?? 87;
    this.#hasNus = options.nus ?? true;
  }

  async connectAsync(): Promise<void> {
    this.connectCount++;
    this.log.push("connect");
    if (this.connectGate) await this.connectGate;
    if (this.connectError) throw this.connectError;
  }

  async disconnectAsync(): Promise<void> {
    this.disconnectAsyncCount++;
    if (this.disconnectError) throw this.disconnectError;
    // Real noble delivers the 'disconnect' event asynchronously.
    void microtask().then(() => this.emitDisconnect());
  }

  async discoverSomeServicesAndCharacteristicsAsync(
    serviceUuids: string[],
    characteristicUuids: string[],
  ): Promise<{ characteristics: FakeNobleCharacteristic[] }> {
    this.discoverCalls.push({ serviceUuids, characteristicUuids });
    if (this.discoverError) throw this.discoverError;

    // Fresh instances every round, mirroring noble's onCharacteristicsDiscover.
    const found: FakeNobleCharacteristic[] = [];
    const wants = (id: string): boolean => characteristicUuids.includes(id);
    if (this.#hasNus && serviceUuids.includes(NUS_ID)) {
      if (wants(RX_ID)) found.push((this.rx = new FakeNobleCharacteristic(RX_ID)));
      if (wants(TX_ID)) {
        this.tx = new FakeNobleCharacteristic(TX_ID);
        this.tx.subscribeError = this.txSubscribeError;
        found.push(this.tx);
      }
      if (this.#led && wants(CTRL_ID)) found.push((this.ctrl = new FakeNobleCharacteristic(CTRL_ID)));
    }
    if (this.#hasBattery && serviceUuids.includes(BATTERY_SVC_ID) && wants(BATTERY_ID)) {
      this.battery = new FakeNobleCharacteristic(BATTERY_ID, Uint8Array.of(this.#batteryLevel));
      this.battery.readGate = this.batteryReadGate;
      found.push(this.battery);
    }
    return { characteristics: found };
  }

  once(event: "disconnect", listener: () => void): this {
    if (event === "disconnect") this.#disconnectListeners.add(listener);
    return this;
  }

  /** Remove one listener by reference (like Node's EventEmitter with once-wrapping). */
  removeListener(event: "disconnect", listener: () => void): this {
    if (event === "disconnect") this.#disconnectListeners.delete(listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined || event === "disconnect") this.#disconnectListeners.clear();
    return this;
  }

  // --- test drivers ---
  emitDisconnect(): void {
    const listeners = [...this.#disconnectListeners];
    this.#disconnectListeners.clear(); // once() semantics
    for (const l of listeners) l();
  }

  disconnectListenerCount(): number {
    return this.#disconnectListeners.size;
  }
}

export interface FakeNobleOptions extends FakePeripheralOptions {
  /** Initial adapter state. Default "poweredOn". */
  state?: string;
  /** Emit the peripheral as soon as scanning starts. Default true. */
  autoDiscover?: boolean;
}

export class FakeNoble {
  state: string;
  scanning = false;
  startScanCount = 0;
  stopScanCount = 0;
  startScanArgs: { serviceUuids: string[]; allowDuplicates: boolean }[] = [];
  startScanError: Error | null = null;
  stopScanError: Error | null = null;
  /** When set, discovered as soon as scanning starts. */
  autoDiscoverPeripheral: FakeNoblePeripheral | null = null;

  #listeners = new Map<string, Set<(...args: never[]) => void>>();

  constructor(state = "poweredOn") {
    this.state = state;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  async startScanningAsync(serviceUuids: string[] = [], allowDuplicates = false): Promise<void> {
    if (this.startScanError) throw this.startScanError;
    this.startScanCount++;
    this.startScanArgs.push({ serviceUuids, allowDuplicates });
    this.scanning = true;
    const peripheral = this.autoDiscoverPeripheral;
    if (peripheral) void microtask().then(() => this.discover(peripheral));
  }

  /** Shared operation-order log (peripherals push "connect", scans push "stopScan"). */
  readonly log: string[] = [];

  async stopScanningAsync(): Promise<void> {
    this.stopScanCount++;
    this.log.push("stopScan");
    if (this.stopScanError) throw this.stopScanError;
    this.scanning = false;
  }

  // --- test drivers ---

  /** Emit a 'discover' event, like an advertisement arriving. */
  discover(peripheral: FakeNoblePeripheral): void {
    const set = this.#listeners.get("discover");
    if (!set) return;
    for (const l of [...set]) (l as (p: FakeNoblePeripheral) => void)(peripheral);
  }

  /** Transition the adapter state, emitting stateChange ONCE (never replayed). */
  setState(state: string): void {
    this.state = state;
    const set = this.#listeners.get("stateChange");
    if (!set) return;
    for (const l of [...set]) (l as (s: string) => void)(state);
  }
}

export interface FakeNobleHandles {
  noble: FakeNoble;
  peripheral: FakeNoblePeripheral;
}

export function makeFakeNoble(options: FakeNobleOptions = {}): FakeNobleHandles {
  const noble = new FakeNoble(options.state ?? "poweredOn");
  const peripheral = new FakeNoblePeripheral(options);
  peripheral.log = noble.log; // one shared operation-order log
  if (options.autoDiscover ?? true) noble.autoDiscoverPeripheral = peripheral;
  return { noble, peripheral };
}
