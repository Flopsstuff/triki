/**
 * NobleTransport lifecycle tests against an injected mock noble (no native module,
 * no radio). The very fact these pass in CI without `@abandonware/noble` installed
 * proves the injected module is used and no dynamic import is attempted.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { NobleTransport, ScanTimeoutError, ConnectAbortedError, nobleUuid } from "./noble";
import { NUS_SERVICE, NUS_RX, BATTERY_SERVICE, BATTERY_LEVEL, startCmd } from "../protocol";
import { makeFakeNoble, FakeNoblePeripheral } from "../testkit/fakeNoble";
import type { FakeNobleOptions } from "../testkit/fakeNoble";
import { deferred } from "../testkit/fakeTransport";
import type { NobleTransportOptions } from "./noble";

/** Let pending microtasks and 0ms timers settle (real timers only). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Recorded {
  frames: Uint8Array[];
  disconnects: number;
  batteries: number[];
}

function rig(
  fakeOptions?: FakeNobleOptions,
  transportOptions?: Omit<NobleTransportOptions, "noble">,
): {
  transport: NobleTransport;
  noble: ReturnType<typeof makeFakeNoble>["noble"];
  peripheral: FakeNoblePeripheral;
  events: Recorded;
} {
  const { noble, peripheral } = makeFakeNoble(fakeOptions);
  const transport = new NobleTransport({ noble, ...transportOptions });
  const events: Recorded = { frames: [], disconnects: 0, batteries: [] };
  transport.attach({
    onFrame: (b) => events.frames.push(b),
    onDisconnect: () => events.disconnects++,
    onBattery: (p) => events.batteries.push(p),
  });
  return { transport, noble, peripheral, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("nobleUuid", () => {
  test("shortens Bluetooth-base UUIDs to 16-bit form, strips dashes otherwise", () => {
    expect(nobleUuid(BATTERY_SERVICE)).toBe("180f");
    expect(nobleUuid(BATTERY_LEVEL)).toBe("2a19");
    expect(nobleUuid(NUS_SERVICE)).toBe("6e400001b5a3f393e0a9e50e24dcca9e");
    expect(nobleUuid("0000180F-0000-1000-8000-00805F9B34FB")).toBe("180f");
  });
});

describe("happy path", () => {
  test("scan -> connect -> one combined discovery -> subscribe -> frames flow", async () => {
    const { transport, noble, peripheral, events } = rig();

    await transport.connect();

    expect(noble.startScanArgs).toEqual([{ serviceUuids: [], allowDuplicates: false }]);
    expect(noble.stopScanCount).toBe(1);
    expect(peripheral.connectCount).toBe(1);
    // NUS + Battery discovered in ONE GATT round trip.
    expect(peripheral.discoverCalls).toHaveLength(1);
    expect(peripheral.discoverCalls[0]!.serviceUuids).toEqual([
      nobleUuid(NUS_SERVICE),
      nobleUuid(BATTERY_SERVICE),
    ]);
    expect(peripheral.discoverCalls[0]!.characteristicUuids).toHaveLength(4);
    expect(peripheral.tx!.subscribeCount).toBe(1);
    expect(transport.hasLed).toBe(true);

    peripheral.tx!.emitData(Uint8Array.of(1, 2, 3));
    expect(events.frames.map((f) => Array.from(f))).toEqual([[1, 2, 3]]);

    await transport.writeRx(startCmd(104), true);
    expect(peripheral.rx!.writes).toHaveLength(1);
    expect(peripheral.rx!.writes[0]!.withoutResponse).toBe(true);

    await transport.writeCtrl(Uint8Array.of(0x01));
    expect(peripheral.ctrl!.writes.map((w) => Array.from(w.data))).toEqual([[0x01]]);
  });

  test("battery is read and subscribed after connect, without blocking it", async () => {
    const { transport, peripheral, events } = rig({ batteryLevel: 61 });
    const gate = deferred();
    peripheral.batteryReadGate = gate.promise;

    await transport.connect(); // resolves while the battery read is still gated
    expect(events.batteries).toEqual([]);

    gate.resolve();
    await flush();
    expect(events.batteries).toEqual([61]);
    expect(peripheral.battery!.subscribeCount).toBe(1);

    peripheral.battery!.emitData(Uint8Array.of(42));
    expect(events.batteries).toEqual([61, 42]);
  });

  test("a stale battery read after disconnect never reaches the handler", async () => {
    const { transport, peripheral, events } = rig();
    const gate = deferred();
    peripheral.batteryReadGate = gate.promise;

    await transport.connect();
    transport.disconnect();
    gate.resolve();
    await flush();

    expect(events.batteries).toEqual([]);
    expect(peripheral.battery!.subscribeCount).toBe(0);
  });

  test("scanServiceUuids are normalized and forwarded to startScanning", async () => {
    const { transport, noble } = rig(undefined, { scanServiceUuids: [NUS_SERVICE] });
    await transport.connect();
    expect(noble.startScanArgs[0]!.serviceUuids).toEqual([nobleUuid(NUS_SERVICE)]);
  });
});

describe("adapter state", () => {
  test.each(["unsupported", "unauthorized"])(
    "an already-terminal state (%s) rejects immediately, no stateChange wait",
    async (state) => {
      const { transport, noble, peripheral } = rig({ state });
      await expect(transport.connect()).rejects.toThrow(`Bluetooth adapter is ${state}.`);
      expect(noble.listenerCount("stateChange")).toBe(0);
      expect(noble.startScanCount).toBe(0);
      expect(peripheral.connectCount).toBe(0);
    },
  );

  test("poweredOff -> poweredOn proceeds to a normal connect", async () => {
    const { transport, noble, peripheral } = rig({ state: "poweredOff" });
    const pending = transport.connect();
    await flush();
    expect(noble.startScanCount).toBe(0); // still waiting for the adapter

    noble.setState("poweredOn");
    await pending;
    expect(peripheral.connectCount).toBe(1);
    expect(noble.listenerCount("stateChange")).toBe(0);
  });

  test("an adapter stuck in poweredOff times out with the adapter message", async () => {
    vi.useFakeTimers();
    const { transport, noble } = rig({ state: "poweredOff" });
    const pending = transport.connect();
    pending.catch(() => {}); // observed via expect below; avoid an unhandled gap

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toThrow(ScanTimeoutError);
    await expect(pending).rejects.toThrow(/adapter did not power on within 15000ms/);
    expect(noble.listenerCount("stateChange")).toBe(0);
  });
});

describe("scan lifecycle", () => {
  test("scan timeout rejects, removes the listener, stops scanning", async () => {
    vi.useFakeTimers();
    const { transport, noble, peripheral } = rig({ autoDiscover: false });
    const pending = transport.connect();
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1); // let the scan start
    expect(noble.listenerCount("discover")).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toThrow(ScanTimeoutError);
    await expect(pending).rejects.toThrow(/name prefix "TRIKI".*15000ms/);
    expect(noble.listenerCount("discover")).toBe(0);
    expect(noble.stopScanCount).toBe(1);

    // A token appearing later must not resurrect the dead attempt.
    noble.discover(peripheral);
    expect(peripheral.connectCount).toBe(0);
  });

  test("a custom scanTimeoutMs is honored; invalid values fall back to the default", async () => {
    vi.useFakeTimers();
    const { transport } = rig({ autoDiscover: false }, { scanTimeoutMs: 500 });
    const pending = transport.connect();
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).rejects.toThrow(/500ms/);

    const bad = rig({ autoDiscover: false }, { scanTimeoutMs: -1 });
    const badPending = bad.transport.connect();
    badPending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(badPending).rejects.toThrow(/15000ms/);
  });

  test("disconnect() during the scan cancels: no zombie session, no listener stacking", async () => {
    const { transport, noble, peripheral, events } = rig({ autoDiscover: false });
    const pending = transport.connect();
    await flush(); // scan armed

    transport.disconnect();
    await expect(pending).rejects.toThrow(ConnectAbortedError);
    expect(noble.listenerCount("discover")).toBe(0);
    expect(noble.stopScanCount).toBe(1);

    // A token appearing later must not connect or flip anything to streaming.
    noble.discover(peripheral);
    await flush();
    expect(peripheral.connectCount).toBe(0);
    expect(events.disconnects).toBe(0); // no connect succeeded -> no onDisconnect

    // A retried connect arms exactly one discover listener (no stacking).
    const retry = transport.connect();
    await flush();
    expect(noble.listenerCount("discover")).toBe(1);
    transport.disconnect();
    await expect(retry).rejects.toThrow(ConnectAbortedError);
    expect(noble.listenerCount("discover")).toBe(0);
  });

  test("a startScanningAsync failure rejects and leaves no listener behind", async () => {
    const { transport, noble } = rig({ autoDiscover: false });
    noble.startScanError = new Error("scan boom");

    await expect(transport.connect()).rejects.toThrow("scan boom");
    expect(noble.listenerCount("discover")).toBe(0);
  });

  test("non-matching advertisements are ignored; address matching is case-insensitive", async () => {
    const { transport, noble, peripheral } = rig(
      { autoDiscover: false, address: "aa:bb:cc:dd:ee:01" },
      { address: "AA:BB:CC:DD:EE:01" },
    );
    const pending = transport.connect();
    await flush();

    noble.discover(new FakeNoblePeripheral({ name: "SOMETHING ELSE", address: "11:22:33:44:55:66" }));
    await flush();
    expect(peripheral.connectCount).toBe(0);

    noble.discover(peripheral);
    await pending;
    expect(peripheral.connectCount).toBe(1);
  });
});

describe("disconnect semantics", () => {
  test("onDisconnect fires exactly once for a remote drop, even if it double-fires", async () => {
    const { transport, peripheral, events } = rig();
    await transport.connect();

    peripheral.emitDisconnect();
    peripheral.emitDisconnect();
    expect(events.disconnects).toBe(1);
    expect(transport.hasLed).toBe(false); // session state was torn down
  });

  test("explicit disconnect() fires onDisconnect once, ignoring noble's async echo", async () => {
    const { transport, peripheral, events } = rig();
    await transport.connect();

    transport.disconnect();
    expect(events.disconnects).toBe(1);
    expect(peripheral.disconnectAsyncCount).toBe(1);

    await flush(); // noble's own 'disconnect' event lands a microtask later
    expect(events.disconnects).toBe(1);
  });

  test("disconnect() when never connected is a silent no-op", async () => {
    const { transport, events } = rig();
    transport.disconnect();
    transport.disconnect();
    expect(events.disconnects).toBe(0);
  });

  test("rejections from noble's disconnect/stopScanning are swallowed, not crashes", async () => {
    const { transport, noble, peripheral } = rig();
    noble.stopScanError = new Error("stop boom");
    peripheral.disconnectError = new Error("hci gone");

    await transport.connect(); // stopScanning failure on the match path is absorbed
    transport.disconnect(); // disconnectAsync rejection is absorbed
    await flush(); // an unhandled rejection here would fail the test run
  });
});

describe("connect failure cleanup", () => {
  test("a TX subscribe failure closes the half-open link without onDisconnect", async () => {
    const { transport, peripheral, events } = rig();
    peripheral.txSubscribeError = new Error("subscribe boom");

    await expect(transport.connect()).rejects.toThrow("subscribe boom");
    expect(peripheral.disconnectAsyncCount).toBe(1);
    expect(events.disconnects).toBe(0); // rejection is the signal, not onDisconnect
  });

  test("a device without NUS RX/TX rejects with a clear error and closes the link", async () => {
    const { transport, peripheral, events } = rig({ nus: false });

    await expect(transport.connect()).rejects.toThrow("NUS RX/TX characteristics not found");
    expect(peripheral.disconnectAsyncCount).toBe(1);
    expect(events.disconnects).toBe(0);
  });

  test("writeRx/writeCtrl reject when not connected", async () => {
    const { transport } = rig();
    await expect(transport.writeRx(Uint8Array.of(1))).rejects.toThrow("Not connected.");
    await expect(transport.writeCtrl(Uint8Array.of(1))).rejects.toThrow(
      "LED control characteristic is not available.",
    );
  });

  test("hasLed reflects the control characteristic's presence", async () => {
    const withLed = rig({ led: true });
    await withLed.transport.connect();
    expect(withLed.transport.hasLed).toBe(true);

    const withoutLed = rig({ led: false });
    await withoutLed.transport.connect();
    expect(withoutLed.transport.hasLed).toBe(false);
    await expect(withoutLed.transport.writeCtrl(Uint8Array.of(1))).rejects.toThrow();
  });
});

describe("reconnect", () => {
  test("re-links to the cached peripheral with no scan, and frames arrive once", async () => {
    const { transport, noble, peripheral, events } = rig();
    await transport.connect();
    peripheral.emitDisconnect();
    expect(events.disconnects).toBe(1);

    await transport.reconnect();
    expect(noble.startScanCount).toBe(1); // NO second scan
    expect(peripheral.connectCount).toBe(2);
    expect(peripheral.discoverCalls).toHaveLength(2); // fresh discovery per session

    // Exactly one frame per notification — old characteristic listeners are dead.
    peripheral.tx!.emitData(Uint8Array.of(9));
    expect(events.frames).toHaveLength(1);
  });

  test("reconnect() before any connect() throws without touching noble", async () => {
    const { transport, noble, peripheral } = rig();
    await expect(transport.reconnect()).rejects.toThrow(
      "No device to reconnect to; call connect() first.",
    );
    expect(() => transport.preflight("reconnect")).toThrow("No device to reconnect to");
    expect(noble.startScanCount).toBe(0);
    expect(peripheral.connectCount).toBe(0);
  });

  test("the device stays reconnectable after a failed first session setup", async () => {
    const { transport, peripheral } = rig();
    peripheral.txSubscribeError = new Error("subscribe boom");
    await expect(transport.connect()).rejects.toThrow("subscribe boom");

    // The scan matched, so the peripheral is remembered; a repaired link reconnects.
    peripheral.txSubscribeError = null;
    await transport.reconnect();
    expect(peripheral.connectCount).toBe(2);
  });
});

describe("ownership and concurrency guards", () => {
  test("attach() twice throws; detach() releases", () => {
    const { noble } = makeFakeNoble();
    const transport = new NobleTransport({ noble });
    const handlers = { onFrame: () => {}, onDisconnect: () => {}, onBattery: () => {} };
    transport.attach(handlers);
    expect(() => transport.attach(handlers)).toThrow("already attached");
    transport.detach();
    expect(() => transport.attach(handlers)).not.toThrow();
  });

  test("overlapping connect() attempts are rejected", async () => {
    const { transport } = rig({ autoDiscover: false });
    const first = transport.connect();
    first.catch(() => {});
    await flush();

    await expect(transport.connect()).rejects.toThrow("already in progress");

    transport.disconnect();
    await expect(first).rejects.toThrow(ConnectAbortedError);

    // And once streaming, another connect() is refused too.
    const { transport: t2 } = rig();
    await t2.connect();
    await expect(t2.connect()).rejects.toThrow("Already connected.");
  });
});
