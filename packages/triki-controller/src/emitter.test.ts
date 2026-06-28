import { describe, test, expect, vi } from "vitest";
import { TypedEmitter } from "./emitter";

interface Events {
  ping: number;
  boom: string;
  [key: string]: unknown;
}

/** TypedEmitter.emit is protected; a tiny subclass exposes it for testing. */
class Bus extends TypedEmitter<Events> {
  fire<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.emit(type, payload);
  }
}

describe("TypedEmitter", () => {
  test("on/emit delivers the typed payload", () => {
    const bus = new Bus();
    const seen: number[] = [];
    bus.on("ping", (n) => seen.push(n));
    bus.fire("ping", 1);
    bus.fire("ping", 2);
    expect(seen).toEqual([1, 2]);
  });

  test("does not cross event types", () => {
    const bus = new Bus();
    const ping = vi.fn();
    bus.on("ping", ping);
    bus.fire("boom", "x");
    expect(ping).not.toHaveBeenCalled();
  });

  test("the returned function unsubscribes", () => {
    const bus = new Bus();
    const fn = vi.fn();
    const off = bus.on("ping", fn);
    bus.fire("ping", 1);
    off();
    bus.fire("ping", 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(1);
  });

  test("off() removes a listener", () => {
    const bus = new Bus();
    const fn = vi.fn();
    bus.on("ping", fn);
    bus.off("ping", fn);
    bus.fire("ping", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  test("once() fires exactly once", () => {
    const bus = new Bus();
    const fn = vi.fn();
    bus.once("ping", fn);
    bus.fire("ping", 1);
    bus.fire("ping", 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  test("a throwing listener is isolated and does not stop the others", () => {
    const bus = new Bus();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", after);
    expect(() => bus.fire("ping", 1)).not.toThrow();
    expect(after).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("removeAllListeners() clears every subscription", () => {
    const bus = new Bus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("ping", a);
    bus.on("boom", b);
    bus.removeAllListeners();
    bus.fire("ping", 1);
    bus.fire("boom", "x");
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  test("unsubscribing mid-dispatch is safe (snapshot iteration)", () => {
    const bus = new Bus();
    const b = vi.fn();
    let offB: () => void = () => {};
    // The first listener removes the second during dispatch.
    bus.on("ping", () => offB());
    offB = bus.on("ping", b);
    expect(() => bus.fire("ping", 1)).not.toThrow();
    // b was already in the dispatch snapshot, so it still ran this round...
    expect(b).toHaveBeenCalledTimes(1);
    // ...but is removed for subsequent emits.
    bus.fire("ping", 2);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
