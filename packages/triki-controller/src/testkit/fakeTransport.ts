/**
 * A scripted in-memory {@link TrikiTransport} for controller tests: no BLE stack at
 * all — tests gate/fail connect() and drive frames/battery/disconnects by hand. It
 * honors the transport contract (exactly-once onDisconnect, reject-on-cancel,
 * idempotent disconnect) so controller tests exercise the same seams a real
 * transport would.
 */
import type { TrikiTransport, TrikiTransportHandlers } from "../transport";

/** A promise with its settle functions exposed — the test-side gate primitive. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeTransport implements TrikiTransport {
  handlers: TrikiTransportHandlers | null = null;
  hasLed = true;
  connected = false;

  /** When set, connect()/reconnect() reject with this error. */
  connectError: Error | null = null;
  /** When set, connect()/reconnect() await this gate (cancellable by disconnect()). */
  connectGate: Promise<void> | null = null;
  /** When set, writeRx() rejects with this error (models a failed START handshake). */
  writeRxError: Error | null = null;

  rxWrites: { data: Uint8Array; withoutResponse: boolean }[] = [];
  ctrlWrites: Uint8Array[] = [];
  connectCount = 0;
  reconnectCount = 0;
  disconnectCount = 0;

  #cancelPending: ((err: Error) => void) | null = null;
  /** Set by disconnect() while a gated connect is pending — checked after the race,
   *  so a cancel that lost the race (gate resolved first, same tick) still lands. */
  #pendingCancelled = false;

  attach(handlers: TrikiTransportHandlers): void {
    if (this.handlers) throw new Error("FakeTransport is already attached.");
    this.handlers = handlers;
  }

  detach(): void {
    this.handlers = null;
  }

  async connect(): Promise<void> {
    this.connectCount++;
    await this.#establish();
  }

  async reconnect(): Promise<void> {
    this.reconnectCount++;
    await this.#establish();
  }

  async #establish(): Promise<void> {
    if (this.connectError) throw this.connectError;
    if (this.connectGate) {
      this.#pendingCancelled = false;
      await Promise.race([
        this.connectGate,
        new Promise<never>((_, reject) => {
          this.#cancelPending = reject;
        }),
      ]);
      this.#cancelPending = null;
      if (this.#pendingCancelled) throw new Error("Connection cancelled by disconnect().");
    }
    this.connected = true;
  }

  async writeRx(data: Uint8Array, withoutResponse = false): Promise<void> {
    if (this.writeRxError) throw this.writeRxError;
    this.rxWrites.push({ data, withoutResponse });
  }

  async writeCtrl(data: Uint8Array): Promise<void> {
    this.ctrlWrites.push(data);
  }

  disconnect(): void {
    this.disconnectCount++;
    if (this.#cancelPending) {
      this.#pendingCancelled = true;
      const cancel = this.#cancelPending;
      this.#cancelPending = null;
      cancel(new Error("Connection cancelled by disconnect()."));
      return;
    }
    if (!this.connected) return; // idempotent; never connected -> no onDisconnect
    this.connected = false;
    this.handlers?.onDisconnect();
  }

  // --- test drivers --------------------------------------------------------------

  emitFrame(bytes: Uint8Array): void {
    this.handlers?.onFrame(bytes);
  }

  /** Simulate a remote link drop (fires the handler regardless of bookkeeping). */
  emitDisconnect(): void {
    this.connected = false;
    this.handlers?.onDisconnect();
  }

  emitBattery(percent: number): void {
    this.handlers?.onBattery(percent);
  }
}
