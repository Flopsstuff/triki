/**
 * Web Bluetooth implementation of {@link TrikiTransport}. This is the only module that
 * touches `navigator.bluetooth`, and it is the default transport used by
 * {@link TrikiController} in the browser.
 */
import {
  NUS_SERVICE,
  NUS_RX,
  NUS_TX,
  NUS_CTRL,
  BATTERY_SERVICE,
  BATTERY_LEVEL,
  DEVICE_NAME_PREFIX,
} from "../protocol";
import type { TrikiTransport, TrikiTransportHandlers } from "../transport";

export class WebBluetoothTransport implements TrikiTransport {
  #device: BluetoothDevice | null = null;
  #gatt: BluetoothRemoteGATTServer | null = null;
  #rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  #txChar: BluetoothRemoteGATTCharacteristic | null = null;
  #ctrlChar: BluetoothRemoteGATTCharacteristic | null = null;
  #batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  #handlers: TrikiTransportHandlers | null = null;
  /** True only between a successful connect()/reconnect() and the next teardown. */
  #connected = false;
  /** True while a connect()/reconnect() is in flight. */
  #connecting = false;
  /** Set by disconnect() during a pending connect; honored at the next checkpoint. */
  #cancelRequested = false;

  /** True when Web Bluetooth is available (safe to call during SSR). */
  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  get hasLed(): boolean {
    return this.#ctrlChar !== null;
  }

  attach(handlers: TrikiTransportHandlers): void {
    if (this.#handlers) throw new Error("WebBluetoothTransport is already attached.");
    this.#handlers = handlers;
  }

  detach(): void {
    this.#handlers = null;
  }

  /** Synchronous pre-flight: fail before any state change when the op cannot succeed. */
  preflight(op: "connect" | "reconnect"): void {
    if (!WebBluetoothTransport.isSupported()) {
      throw new Error("Web Bluetooth is not available in this environment.");
    }
    if (op === "reconnect" && !this.#device) {
      throw new Error("No device to reconnect to; call connect() first.");
    }
  }

  /**
   * Show the browser device picker and open a session. Must be called from a user
   * gesture (e.g. a click handler).
   */
  async connect(): Promise<void> {
    this.preflight("connect");
    this.#connecting = true;
    this.#cancelRequested = false;
    try {
      // A pending requestDevice picker cannot be cancelled programmatically;
      // disconnect() during it takes effect at the checkpoint below.
      this.#device = await navigator.bluetooth.requestDevice({
        // Web Bluetooth prefix matching is case-sensitive, hence both shipped casings
        // (noble's transport matches case-insensitively — inherently broader).
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }, { namePrefix: "Triki" }],
        optionalServices: [NUS_SERVICE, BATTERY_SERVICE],
      });
      this.#checkCancelled();
      await this.#openSession();
    } finally {
      this.#connecting = false;
      this.#cancelRequested = false;
    }
  }

  /** Reconnect to the previously paired device without showing the picker. */
  async reconnect(): Promise<void> {
    this.preflight("reconnect");
    this.#connecting = true;
    this.#cancelRequested = false;
    try {
      await this.#openSession();
    } finally {
      this.#connecting = false;
      this.#cancelRequested = false;
    }
  }

  async writeRx(data: Uint8Array, withoutResponse = false): Promise<void> {
    if (!this.#rxChar) throw new Error("Not connected.");
    await this.#write(this.#rxChar, data, withoutResponse);
  }

  async writeCtrl(data: Uint8Array): Promise<void> {
    if (!this.#ctrlChar) throw new Error("LED control characteristic is not available.");
    await this.#write(this.#ctrlChar, data, false);
  }

  disconnect(): void {
    if (this.#connecting) {
      // Cancel the pending connect: the in-flight session setup rejects at its next
      // checkpoint (or its GATT await fails once the link drops). No onDisconnect —
      // the connect() rejection is the signal.
      this.#cancelRequested = true;
      if (this.#gatt?.connected) this.#gatt.disconnect();
      return;
    }
    if (this.#gatt?.connected) this.#gatt.disconnect();
    // Never connected (or already torn down): idempotent no-op, no onDisconnect.
  }

  // --- internal ----------------------------------------------------------------

  #checkCancelled(): void {
    if (this.#cancelRequested) throw new Error("Connection cancelled by disconnect().");
  }

  async #openSession(): Promise<void> {
    const device = this.#device;
    if (!device || !device.gatt) throw new Error("Device GATT is not available.");
    try {
      // Same listener reference, so re-adding on reconnect is a no-op.
      device.addEventListener("gattserverdisconnected", this.#onGattDisconnected);

      this.#gatt = await device.gatt.connect();
      this.#checkCancelled();
      const svc = await this.#gatt.getPrimaryService(NUS_SERVICE);
      this.#checkCancelled();
      this.#rxChar = await svc.getCharacteristic(NUS_RX);
      this.#checkCancelled();
      this.#txChar = await svc.getCharacteristic(NUS_TX);
      this.#checkCancelled();
      try {
        this.#ctrlChar = await svc.getCharacteristic(NUS_CTRL);
      } catch {
        this.#ctrlChar = null;
      }
      this.#checkCancelled();

      await this.#txChar.startNotifications();
      this.#checkCancelled();
      this.#txChar.addEventListener("characteristicvaluechanged", this.#onNotify);

      this.#connected = true;
      void this.#startBattery(this.#gatt); // best-effort; never blocks streaming
    } catch (err) {
      // Don't leave a half-open link behind a rejected connect. If the GATT drop
      // fires #onGattDisconnected, #connected is still false, so no onDisconnect.
      try {
        if (this.#gatt?.connected) this.#gatt.disconnect();
      } catch {
        /* best-effort */
      }
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
    this.#handlers?.onBattery(view.getUint8(0));
  }

  #onNotify = (event: Event): void => {
    const char = event.target as BluetoothRemoteGATTCharacteristic;
    const view = char.value;
    if (!view) return;
    // byteOffset/byteLength are load-bearing: the underlying buffer may be larger.
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.#handlers?.onFrame(bytes);
  };

  #onGattDisconnected = (): void => {
    // onDisconnect fires exactly once per successful connect — and never for a
    // link that dropped before connect() resolved (the rejection is the signal).
    const wasConnected = this.#connected;
    this.#teardown();
    if (wasConnected) this.#handlers?.onDisconnect();
  };

  #teardown(): void {
    this.#connected = false;
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
