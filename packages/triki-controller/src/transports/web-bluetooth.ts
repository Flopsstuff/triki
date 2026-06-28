/**
 * Web Bluetooth implementation of {@link TrikiTransport}. This is the only module that
 * touches `navigator.bluetooth`, and it is the default transport used by
 * {@link TrikiController} in the browser.
 */
import { NUS_SERVICE, NUS_RX, NUS_TX, NUS_CTRL, BATTERY_SERVICE, BATTERY_LEVEL } from "../protocol";
import type { TrikiTransport } from "../transport";

export class WebBluetoothTransport implements TrikiTransport {
  #device: BluetoothDevice | null = null;
  #gatt: BluetoothRemoteGATTServer | null = null;
  #rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  #txChar: BluetoothRemoteGATTCharacteristic | null = null;
  #ctrlChar: BluetoothRemoteGATTCharacteristic | null = null;
  #batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  #frameHandler: ((bytes: Uint8Array) => void) | null = null;
  #disconnectHandler: (() => void) | null = null;
  #batteryHandler: ((percent: number) => void) | null = null;

  /** True when Web Bluetooth is available (safe to call during SSR). */
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
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

  /**
   * Show the browser device picker and open a session. Must be called from a user
   * gesture (e.g. a click handler).
   */
  async connect(): Promise<void> {
    if (!WebBluetoothTransport.isSupported()) {
      throw new Error("Web Bluetooth is not available in this environment.");
    }
    this.#device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "TRIKI" }, { namePrefix: "Triki" }],
      optionalServices: [NUS_SERVICE, BATTERY_SERVICE],
    });
    await this.#openSession();
  }

  /** Reconnect to the previously paired device without showing the picker. */
  async reconnect(): Promise<void> {
    if (!this.#device) throw new Error("No device to reconnect to; call connect() first.");
    await this.#openSession();
  }

  async writeRx(data: Uint8Array, withoutResponse = false): Promise<void> {
    if (!this.#rxChar) throw new Error("Not connected.");
    await this.#write(this.#rxChar, data, withoutResponse);
  }

  async writeCtrl(data: Uint8Array): Promise<void> {
    if (!this.#ctrlChar) throw new Error("LED control characteristic is not available.");
    await this.#ctrlChar.writeValue(data as BufferSource);
  }

  disconnect(): void {
    if (this.#gatt && this.#gatt.connected) this.#gatt.disconnect();
    else this.#onGattDisconnected();
  }

  // --- internal ----------------------------------------------------------------

  async #openSession(): Promise<void> {
    const device = this.#device;
    if (!device || !device.gatt) throw new Error("Device GATT is not available.");
    try {
      // Same listener reference, so re-adding on reconnect is a no-op.
      device.addEventListener("gattserverdisconnected", this.#onGattDisconnected);

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

      void this.#startBattery(this.#gatt); // best-effort; never blocks streaming
    } catch (err) {
      this.#teardown();
      throw err;
    }
  }

  /**
   * Read the battery level once and subscribe to updates, if the service exists.
   * Fire-and-forget: `gatt` pins the session, and we bail after each await once it is
   * no longer the active connection so a stale read/listener can't outlive teardown.
   */
  async #startBattery(gatt: BluetoothRemoteGATTServer | null): Promise<void> {
    if (!gatt) return;
    try {
      const svc = await gatt.getPrimaryService(BATTERY_SERVICE);
      if (this.#gatt !== gatt) return;
      const char = await svc.getCharacteristic(BATTERY_LEVEL);
      if (this.#gatt !== gatt) return;
      const value = await char.readValue();
      if (this.#gatt !== gatt) return;
      this.#emitBattery(value);
      this.#batteryChar = char;
      try {
        await char.startNotifications();
        if (this.#gatt !== gatt) {
          this.#batteryChar = null; // disconnected mid-subscribe; don't leak a listener
          return;
        }
        char.addEventListener("characteristicvaluechanged", this.#onBattery);
      } catch {
        this.#batteryChar = null; // notifications unsupported; the one-time read stands
      }
    } catch {
      this.#batteryChar = null; // no Battery service on this token
    }
  }

  #onBattery = (event: Event): void => {
    const char = event.target as BluetoothRemoteGATTCharacteristic;
    if (char.value) this.#emitBattery(char.value);
  };

  #emitBattery(view: DataView): void {
    this.#batteryHandler?.(view.getUint8(0));
  }

  #onNotify = (event: Event): void => {
    const char = event.target as BluetoothRemoteGATTCharacteristic;
    const view = char.value;
    if (!view) return;
    // byteOffset/byteLength are load-bearing: the underlying buffer may be larger.
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.#frameHandler?.(bytes);
  };

  #onGattDisconnected = (): void => {
    this.#teardown();
    this.#disconnectHandler?.();
  };

  #teardown(): void {
    if (this.#txChar) {
      try {
        this.#txChar.removeEventListener("characteristicvaluechanged", this.#onNotify);
      } catch {
        /* ignore */
      }
    }
    if (this.#batteryChar) {
      try {
        this.#batteryChar.removeEventListener("characteristicvaluechanged", this.#onBattery);
      } catch {
        /* ignore */
      }
    }
    if (this.#device) {
      try {
        this.#device.removeEventListener("gattserverdisconnected", this.#onGattDisconnected);
      } catch {
        /* ignore */
      }
    }
    this.#rxChar = null;
    this.#txChar = null;
    this.#ctrlChar = null;
    this.#batteryChar = null;
    this.#gatt = null;
    // #device is retained so reconnect() can reuse it without the picker.
  }

  async #write(
    char: BluetoothRemoteGATTCharacteristic,
    data: Uint8Array,
    withoutResponse: boolean,
  ): Promise<void> {
    if (withoutResponse && typeof char.writeValueWithoutResponse === "function") {
      await char.writeValueWithoutResponse(data as BufferSource);
    } else {
      await char.writeValue(data as BufferSource);
    }
  }
}
