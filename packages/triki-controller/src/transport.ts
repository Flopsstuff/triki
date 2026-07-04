/**
 * Transport abstraction for the Żabka Triki token.
 *
 * A transport is a dumb Nordic UART Service (NUS) pipe: it connects to the device,
 * writes command bytes to RX, exposes the optional control (LED) characteristic, and
 * streams TX notification bytes back. It knows nothing about the Triki protocol — the
 * {@link TrikiController} builds the START/LED commands and parses the motion frames —
 * so protocol logic lives in exactly one place and new transports stay tiny.
 *
 * Ownership is explicit: the controller claims a transport with {@link
 * TrikiTransport.attach} (one owner at a time) and hands over a {@link
 * TrikiTransportHandlers} object. A transport only ever calls the handlers it has data
 * for, so minimal transports (no battery, no reconnect) need no stub members.
 *
 * `TrikiController` defaults to a `WebBluetoothTransport` (browser). A `NobleTransport`
 * (Node, via `@abandonware/noble`) is available from the `triki-controller/node` entry.
 */

/** Callbacks a {@link TrikiTransport} owner registers via {@link TrikiTransport.attach}. */
export interface TrikiTransportHandlers {
  /** Inbound TX notification bytes (raw). Only called while a connection is active. */
  onFrame(bytes: Uint8Array): void;

  /**
   * The link went down — lost, or torn down by {@link TrikiTransport.disconnect}.
   * Fires exactly once per successful `connect()`/`reconnect()`, and never when no
   * connect has succeeded (a failed connect signals through its rejection instead).
   */
  onDisconnect(): void;

  /**
   * A battery-level reading (percent, 0–100). Transports that can read the standard
   * Battery service call it on connect and on each update; others never call it.
   */
  onBattery(percent: number): void;
}

export interface TrikiTransport {
  /**
   * Claim this transport and register the owner's callbacks. A transport serves one
   * owner at a time: throws if already attached (call {@link detach} first). The
   * controller attaches once, in its constructor, before any {@link connect}.
   */
  attach(handlers: TrikiTransportHandlers): void;

  /**
   * Release the transport so it can be attached again. Does not tear down an active
   * link — call {@link disconnect} first. Safe no-op when not attached.
   */
  detach(): void;

  /**
   * Optional synchronous pre-flight check: throw a descriptive Error when the given
   * operation cannot possibly succeed (e.g. Web Bluetooth missing, or `reconnect`
   * before any successful connect). The controller calls it before entering the
   * `pairing` state, so failures reject without emitting any `connectionchange`
   * events.
   */
  preflight?(op: "connect" | "reconnect"): void;

  /**
   * Find/select the device, connect, discover the NUS characteristics, and start TX
   * notifications. Resolves once frames can flow.
   *
   * Contract: on failure it rejects AFTER cleaning up its own resources and MUST NOT
   * invoke `handlers.onDisconnect()` (no connect succeeded — the rejection is the
   * signal). If {@link disconnect} is called while `connect()` is pending, `connect()`
   * must reject.
   */
  connect(): Promise<void>;

  /**
   * Reconnect to the previously selected device without re-prompting. Optional —
   * transports that cannot remember a device may omit it, in which case
   * {@link TrikiController.reconnect} rejects with a clear error. Same contract as
   * {@link connect}.
   */
  reconnect?(): Promise<void>;

  /** Write a command to the NUS RX characteristic (host -> token). */
  writeRx(data: Uint8Array, withoutResponse?: boolean): Promise<void>;

  /** Whether the control (LED) characteristic is present on the connected device. */
  readonly hasLed: boolean;

  /** Write to the control (LED) characteristic. Rejects when {@link hasLed} is false. */
  writeCtrl(data: Uint8Array): Promise<void>;

  /**
   * Tear down the connection. Idempotent and safe to call in any state.
   *
   * Contract: if a connection is active (`connect()`/`reconnect()` resolved and
   * `onDisconnect` has not fired since), tear it down and fire
   * `handlers.onDisconnect()` exactly once. If a `connect()` is pending, cancel it so
   * the pending promise rejects (still without firing `onDisconnect`). Otherwise do
   * nothing — NEVER fire `onDisconnect()` when no connect has succeeded.
   */
  disconnect(): void;
}
