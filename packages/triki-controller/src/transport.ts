/**
 * Transport abstraction for the Żabka Triki token.
 *
 * A transport is a dumb Nordic UART Service (NUS) pipe: it connects to the device,
 * writes command bytes to RX, exposes the optional control (LED) characteristic, and
 * streams TX notification bytes back. It knows nothing about the Triki protocol — the
 * {@link TrikiController} builds the START/LED commands and parses the motion frames —
 * so protocol logic lives in exactly one place and new transports stay tiny.
 *
 * `TrikiController` defaults to a `WebBluetoothTransport` (browser). A `NobleTransport`
 * (Node, via `@abandonware/noble`) is available from the `triki-controller/node` entry.
 */
export interface TrikiTransport {
  /**
   * Find/select the device, connect, discover the NUS characteristics, and start TX
   * notifications. Resolves once frames can flow; rejects (after cleaning up) on failure.
   */
  connect(): Promise<void>;

  /**
   * Reconnect to the previously selected device without re-prompting. Optional —
   * transports that cannot remember a device may omit it, in which case
   * {@link TrikiController.reconnect} throws a clear error.
   */
  reconnect?(): Promise<void>;

  /** Write a command to the NUS RX characteristic (host -> token). */
  writeRx(data: Uint8Array, withoutResponse?: boolean): Promise<void>;

  /** Whether the control (LED) characteristic is present on the connected device. */
  readonly hasLed: boolean;

  /** Write to the control (LED) characteristic. Rejects when {@link hasLed} is false. */
  writeCtrl(data: Uint8Array): Promise<void>;

  /**
   * Register the handler for inbound TX notification chunks (raw bytes). Called once by
   * the controller; the transport invokes it for every notification while connected.
   */
  onFrame(handler: (bytes: Uint8Array) => void): void;

  /**
   * Register the handler for a disconnect — whether a lost link or the result of
   * {@link disconnect}. Called once by the controller.
   */
  onDisconnect(handler: () => void): void;

  /**
   * Register the handler for battery-level readings (percent, 0–100). Called once by
   * the controller. Transports that can read the standard Battery service invoke it on
   * connect and on each update; others may never call it.
   */
  onBattery(handler: (percent: number) => void): void;

  /**
   * Tear down the connection. Guarantees the {@link onDisconnect} handler fires once
   * when a connection was active; a safe no-op otherwise.
   */
  disconnect(): void;
}
