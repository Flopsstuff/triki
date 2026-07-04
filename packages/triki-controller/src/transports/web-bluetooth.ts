/**
 * Web Bluetooth implementation of {@link TrikiTransport}. This is the only module that
 * touches `navigator.bluetooth`, and it is the default transport used by
 * {@link TrikiController} in the browser.
 *
 * Session state is built in locals and committed to the instance only after every
 * setup step succeeds, so a failed or cancelled attempt never leaves half-built state
 * behind and can never clobber a newer attempt's session.
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
import { ConnectAbortedError } from "../transport";
import type { TrikiTransport, TrikiTransportHandlers } from "../transport";

/** Bookkeeping for one in-flight connect()/reconnect(). */
interface ConnectAttempt {
  cancelled: boolean;
}

export class WebBluetoothTransport implements TrikiTransport {
  #device: BluetoothDevice | null = null;
  #gatt: BluetoothRemoteGATTServer | null = null;
  #rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  #txChar: BluetoothRemoteGATTCharacteristic | null = null;
  #ctrlChar: BluetoothRemoteGATTCharacteristic | null = null;
  #batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  #handlers: TrikiTransportHandlers | null = null;
  /** True only between a committed connect()/reconnect() and the next teardown. */
  #connected = false;
  /** The one in-flight connect/reconnect attempt, if any. */
  #attempt: ConnectAttempt | null = null;

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
    const attempt = this.#beginAttempt();
    try {
      // A pending requestDevice picker cannot be cancelled programmatically;
      // disconnect() during it takes effect at the checkpoint below.
      const device = await navigator.bluetooth.requestDevice({
        // Web Bluetooth prefix matching is case-sensitive, hence both shipped casings
        // (noble's transport matches case-insensitively — inherently broader).
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }, { namePrefix: "Triki" }],
        optionalServices: [NUS_SERVICE, BATTERY_SERVICE],
      });
      this.#checkCancelled(attempt);
      this.#device = device;
      await this.#openSession(attempt);
    } finally {
      if (this.#attempt === attempt) this.#attempt = null;
    }
  }

  /** Reconnect to the previously paired device without showing the picker. */
  async reconnect(): Promise<void> {
    this.preflight("reconnect");
    const attempt = this.#beginAttempt();
    try {
      await this.#openSession(attempt);
    } finally {
      if (this.#attempt === attempt) this.#attempt = null;
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
    if (this.#connected) {
      // Active session: the browser fires gattserverdisconnected synchronously inside
      // gatt.disconnect() (per spec), driving teardown + onDisconnect exactly once.
      if (this.#gatt?.connected) this.#gatt.disconnect();
      else this.#onGattDisconnected();
      return;
    }
    const attempt = this.#attempt;
    if (attempt) {
      // Cancel the pending connect: the attempt rejects at its next checkpoint (a
      // pending picker cannot be interrupted). #attempt is cleared HERE so a retry
      // connect() is not refused; the cancelled attempt only ever touches its own
      // locals, so the retry cannot be clobbered. No onDisconnect — the connect()
      // rejection is the signal.
      attempt.cancelled = true;
      this.#attempt = null;
      return;
    }
    // Never connected (or already torn down): idempotent no-op, no onDisconnect.
  }

  // --- internal ----------------------------------------------------------------

  #beginAttempt(): ConnectAttempt {
    if (this.#attempt) throw new Error("connect() is already in progress.");
    if (this.#connected) throw new Error("Already connected.");
    const attempt: ConnectAttempt = { cancelled: false };
    this.#attempt = attempt;
    return attempt;
  }

  #checkCancelled(attempt: ConnectAttempt): void {
    if (attempt.cancelled) throw new ConnectAbortedError("Connection cancelled by disconnect().");
  }

  /**
   * Open a GATT session on #device. Built entirely in locals; instance state is
   * committed only after the last step succeeds. On failure the local link is
   * dropped and no instance field has changed.
   */
  async #openSession(attempt: ConnectAttempt): Promise<void> {
    const device = this.#device;
    if (!device || !device.gatt) throw new Error("Device GATT is not available.");
    let gatt: BluetoothRemoteGATTServer | null = null;
    try {
      gatt = await device.gatt.connect();
      this.#checkCancelled(attempt);
      const svc = await gatt.getPrimaryService(NUS_SERVICE);
      this.#checkCancelled(attempt);
      const rx = await svc.getCharacteristic(NUS_RX);
      this.#checkCancelled(attempt);
      const tx = await svc.getCharacteristic(NUS_TX);
      this.#checkCancelled(attempt);
      let ctrl: BluetoothRemoteGATTCharacteristic | null;
      try {
        ctrl = await svc.getCharacteristic(NUS_CTRL);
      } catch {
        ctrl = null;
      }
      this.#checkCancelled(attempt);

      await tx.startNotifications();
      this.#checkCancelled(attempt);

      // Commit: from here on this is the live session.
      this.#gatt = gatt;
      this.#rxChar = rx;
      this.#txChar = tx;
      this.#ctrlChar = ctrl;
      tx.addEventListener("characteristicvaluechanged", this.#onNotify);
      // Same listener reference, so re-adding on reconnect is a no-op.
      device.addEventListener("gattserverdisconnected", this.#onGattDisconnected);
      this.#connected = true;
      void this.#startBattery(gatt); // best-effort; never blocks streaming
    } catch (err) {
      // Don't leave a half-open link behind a rejected connect. Only locals were
      // touched, so a newer attempt's session (if any) is unaffected.
      try {
        if (gatt?.connected) gatt.disconnect();
      } catch {
        /* best-effort */
      }
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
    // A 0-byte ATT value is protocol-legal (flaky firmware); getUint8(0) would throw.
    if (view.byteLength) this.#handlers?.onBattery(view.getUint8(0));
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
    // onDisconnect fires exactly once per committed session — and never for a link
    // that dropped before connect() resolved (the rejection is the signal).
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
