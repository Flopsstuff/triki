/**
 * Minimal in-memory fake of the Web Bluetooth surface the {@link TrikiController}
 * touches: `navigator.bluetooth.requestDevice` → device → GATT → services →
 * characteristics. Characteristics extend `EventTarget`, so a test can deliver a
 * notification with {@link FakeCharacteristic.notify} and the controller's real
 * `characteristicvaluechanged` listener fires exactly as it would on hardware.
 *
 * Lives under `src/testkit/` so it is excluded from coverage and never shipped.
 */
import { NUS_SERVICE, NUS_RX, NUS_TX, NUS_CTRL, BATTERY_SERVICE, BATTERY_LEVEL } from "../protocol";

/** A fake GATT characteristic that records writes and can push notifications. */
export class FakeCharacteristic extends EventTarget {
  /** The most recent value, as the controller reads it via `event.target.value`. */
  value: DataView | undefined;
  /** Every payload written via `writeValue` / `writeValueWithoutResponse`, copied. */
  readonly writes: Uint8Array[] = [];
  startNotificationsCount = 0;
  #readValue: DataView;

  constructor(readValue?: DataView) {
    super();
    this.#readValue = readValue ?? new DataView(new ArrayBuffer(1));
  }

  async writeValue(data: Uint8Array): Promise<void> {
    this.writes.push(data.slice());
  }

  async writeValueWithoutResponse(data: Uint8Array): Promise<void> {
    this.writes.push(data.slice());
  }

  async startNotifications(): Promise<this> {
    this.startNotificationsCount++;
    return this;
  }

  async stopNotifications(): Promise<this> {
    return this;
  }

  async readValue(): Promise<DataView> {
    this.value = this.#readValue;
    return this.#readValue;
  }

  /** Test helper: deliver a `characteristicvaluechanged` carrying `bytes`. */
  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }

  /** Test helper: deliver a single-byte (e.g. battery percent) notification. */
  notifyByte(n: number): void {
    this.value = new DataView(Uint8Array.of(n).buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

/** A fake GATT primary service holding a fixed characteristic map. */
export class FakeService {
  #chars: Map<string, FakeCharacteristic>;
  constructor(chars: Map<string, FakeCharacteristic>) {
    this.#chars = chars;
  }
  async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
    const c = this.#chars.get(uuid);
    if (!c) throw new Error(`fake: no characteristic ${uuid}`);
    return c;
  }
}

/** A fake GATT server. `disconnect()` fires `gattserverdisconnected` on the device. */
export class FakeGatt {
  connected = false;
  device!: FakeDevice;
  #services: Map<string, FakeService>;
  constructor(services: Map<string, FakeService>) {
    this.#services = services;
  }
  async connect(): Promise<this> {
    this.connected = true;
    return this;
  }
  async getPrimaryService(uuid: string): Promise<FakeService> {
    const s = this.#services.get(uuid);
    if (!s) throw new Error(`fake: no service ${uuid}`);
    return s;
  }
  disconnect(): void {
    this.connected = false;
    this.device.dispatchEvent(new Event("gattserverdisconnected"));
  }
}

/** A fake BLE device. */
export class FakeDevice extends EventTarget {
  gatt: FakeGatt;
  constructor(gatt: FakeGatt) {
    super();
    this.gatt = gatt;
  }
}

/** A fake `navigator.bluetooth`. */
export class FakeBluetooth {
  requestDeviceCount = 0;
  #device: FakeDevice;
  constructor(device: FakeDevice) {
    this.#device = device;
  }
  async requestDevice(_options?: unknown): Promise<FakeDevice> {
    this.requestDeviceCount++;
    return this.#device;
  }
}

/** Handles a test can drive after wiring a fake stack with {@link makeFakeBluetooth}. */
export interface FakeBleHandles {
  bluetooth: FakeBluetooth;
  device: FakeDevice;
  gatt: FakeGatt;
  rx: FakeCharacteristic;
  tx: FakeCharacteristic;
  /** LED control characteristic, or `null` when `led: false`. */
  ctrl: FakeCharacteristic | null;
  /** Battery Level characteristic, or `null` when `battery: false`. */
  battery: FakeCharacteristic | null;
}

export interface FakeBleOptions {
  /** Expose the NUS control (LED) characteristic. Default true. */
  led?: boolean;
  /** Expose the standard Battery service. Default true. */
  battery?: boolean;
  /** Initial battery percent returned by `readValue`. Default 87. */
  batteryLevel?: number;
}

/** Wire a complete fake Web Bluetooth stack and return handles to drive it. */
export function makeFakeBluetooth(options: FakeBleOptions = {}): FakeBleHandles {
  const { led = true, battery = true, batteryLevel = 87 } = options;

  const rx = new FakeCharacteristic();
  const tx = new FakeCharacteristic();
  const ctrl = led ? new FakeCharacteristic() : null;
  const batteryChar = battery ? new FakeCharacteristic(new DataView(Uint8Array.of(batteryLevel).buffer)) : null;

  const nusChars = new Map<string, FakeCharacteristic>([
    [NUS_RX, rx],
    [NUS_TX, tx],
  ]);
  if (ctrl) nusChars.set(NUS_CTRL, ctrl);

  const services = new Map<string, FakeService>([[NUS_SERVICE, new FakeService(nusChars)]]);
  if (batteryChar) {
    services.set(BATTERY_SERVICE, new FakeService(new Map([[BATTERY_LEVEL, batteryChar]])));
  }

  const gatt = new FakeGatt(services);
  const device = new FakeDevice(gatt);
  gatt.device = device;
  const bluetooth = new FakeBluetooth(device);

  return { bluetooth, device, gatt, rx, tx, ctrl, battery: batteryChar };
}
