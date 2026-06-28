/**
 * A tiny, dependency-free, strongly-typed event emitter. Each event type maps to a
 * payload type, so `on("frame", cb)` infers `cb`'s argument. `on`/`once` return an
 * unsubscribe function. Listener exceptions are isolated so a throwing subscriber
 * cannot break the BLE notification pipeline.
 */
export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

export class TypedEmitter<M extends Record<string, unknown>> {
  #listeners = new Map<keyof M, Set<Listener<unknown>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof M>(type: K, listener: Listener<M[K]>): Unsubscribe {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as Listener<unknown>);
    return () => this.off(type, listener);
  }

  /** Subscribe to the next occurrence only. Returns an unsubscribe function. */
  once<K extends keyof M>(type: K, listener: Listener<M[K]>): Unsubscribe {
    const wrapped: Listener<M[K]> = (payload) => {
      this.off(type, wrapped);
      listener(payload);
    };
    return this.on(type, wrapped);
  }

  /** Remove a previously registered listener. */
  off<K extends keyof M>(type: K, listener: Listener<M[K]>): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    set.delete(listener as Listener<unknown>);
    if (set.size === 0) this.#listeners.delete(type);
  }

  /** Remove all listeners for all event types. */
  removeAllListeners(): void {
    this.#listeners.clear();
  }

  /** Dispatch an event to all listeners. Iterates a snapshot so listeners may unsubscribe mid-dispatch. */
  protected emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<M[K]>)(payload);
      } catch (err) {
        console.error("[triki-controller] event listener threw:", err);
      }
    }
  }
}
