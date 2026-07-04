/**
 * Controller <-> transport seam tests, driven through an injected scripted
 * {@link FakeTransport} (no Web Bluetooth involved): failure cleanup, cancellation,
 * state guards, and the constructor's transport validation.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { TrikiController } from "./controller";
import { startCmd } from "./protocol";
import { FakeTransport, deferred } from "./testkit/fakeTransport";
import { frame } from "./testkit/frames";
import type { ConnectionState, FrameEvent, TrikiControllerOptions } from "./events";
import type { TrikiTransport } from "./transport";

const created: TrikiController[] = [];

/** Construct a controller and track it so afterEach tears down its rate timer. */
function make(options?: TrikiControllerOptions): TrikiController {
  const c = new TrikiController(options);
  created.push(c);
  return c;
}

/** Controller + fake transport + recorded connectionchange history. */
function rig(): { ctrl: TrikiController; t: FakeTransport; states: ConnectionState[] } {
  const t = new FakeTransport();
  const ctrl = make({ fusion: "none", transport: t });
  const states: ConnectionState[] = [];
  ctrl.on("connectionchange", (s) => states.push(s));
  return { ctrl, t, states };
}

afterEach(() => {
  for (const c of created.splice(0)) c.disconnect();
  vi.restoreAllMocks();
});

describe("happy path through an injected transport", () => {
  test("connect sends START, streams frames, disconnect tears down once", async () => {
    const { ctrl, t, states } = rig();

    await ctrl.connect();
    expect(states).toEqual(["pairing", "streaming"]);
    expect(Array.from(t.rxWrites[0]!.data)).toEqual(Array.from(startCmd(104)));

    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));
    t.emitFrame(frame(0, 0, 0, 0, 0, 2048));
    expect(frames).toHaveLength(1);

    ctrl.disconnect();
    expect(states).toEqual(["pairing", "streaming", "disconnected"]);
  });

  test("a minimal object-literal transport (per the docs) is enough", async () => {
    // Exactly the members the Custom Transports docs list — no battery, no reconnect.
    let handlers: Parameters<TrikiTransport["attach"]>[0] | null = null;
    const minimal: TrikiTransport = {
      attach: (h) => {
        handlers = h;
      },
      detach: () => {
        handlers = null;
      },
      connect: async () => {},
      writeRx: async () => {},
      writeCtrl: async () => {},
      hasLed: false,
      disconnect: () => {
        handlers?.onDisconnect();
      },
    };
    const ctrl = make({ fusion: "none", transport: minimal });

    await ctrl.connect();
    expect(ctrl.state).toBe("streaming");
    expect(ctrl.battery).toBeNull();

    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));
    handlers!.onFrame(frame(0, 0, 0, 0, 0, 2048));
    expect(frames).toHaveLength(1);
  });
});

describe("connect failure cleanup", () => {
  test("transport.connect() rejection: pairing -> disconnected, transport closed", async () => {
    const { ctrl, t, states } = rig();
    t.connectError = new Error("no adapter");

    await expect(ctrl.connect()).rejects.toThrow("no adapter");
    expect(states).toEqual(["pairing", "disconnected"]);
    expect(ctrl.state).toBe("disconnected");
    expect(t.disconnectCount).toBeGreaterThanOrEqual(1); // half-open link closed
  });

  test("START write rejection: transport closed, no zombie frames, still recoverable", async () => {
    const { ctrl, t, states } = rig();
    t.writeRxError = new Error("GATT write failed");

    await expect(ctrl.connect()).rejects.toThrow("GATT write failed");
    expect(states).toEqual(["pairing", "disconnected"]);
    // The transport was told to tear down the connected-but-not-streaming link.
    expect(t.disconnectCount).toBeGreaterThanOrEqual(1);
    expect(t.connected).toBe(false);

    // Notifications from the (hypothetically) lingering link never become events.
    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));
    t.emitFrame(frame(1, 0, 0, 0, 0, 0));
    expect(frames).toHaveLength(0);

    // And the controller is not wedged: a later connect() works.
    t.writeRxError = null;
    await ctrl.connect();
    expect(ctrl.state).toBe("streaming");
  });
});

describe("disconnect during a pending connect", () => {
  test("cancels: connect() rejects, state never reaches streaming", async () => {
    const { ctrl, t, states } = rig();
    const gate = deferred();
    t.connectGate = gate.promise;

    const pending = ctrl.connect();
    expect(ctrl.state).toBe("pairing");

    ctrl.disconnect();
    await expect(pending).rejects.toThrow("cancelled");
    expect(ctrl.state).toBe("disconnected");
    expect(states).toEqual(["pairing", "disconnected"]);

    // A late gate resolution must not resurrect the session.
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.state).toBe("disconnected");
    expect(states).toEqual(["pairing", "disconnected"]);
  });
});

describe("state guards", () => {
  test("frames outside streaming are ignored (pairing and after disconnect)", async () => {
    const { ctrl, t } = rig();
    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));

    const gate = deferred();
    t.connectGate = gate.promise;
    const pending = ctrl.connect();
    t.emitFrame(frame(1, 0, 0, 0, 0, 0)); // during pairing
    expect(frames).toHaveLength(0);

    gate.resolve();
    await pending;
    t.emitFrame(frame(1, 0, 0, 0, 0, 0)); // streaming: counts
    expect(frames).toHaveLength(1);

    ctrl.disconnect();
    t.emitFrame(frame(1, 0, 0, 0, 0, 0)); // after disconnect: ignored
    expect(frames).toHaveLength(1);
  });

  test("battery during pairing is kept; battery after disconnect is dropped", async () => {
    const { ctrl, t } = rig();
    const readings: number[] = [];
    ctrl.on("battery", (p) => readings.push(p));

    const gate = deferred();
    t.connectGate = gate.promise;
    const pending = ctrl.connect();
    t.emitBattery(77); // fire-and-forget reads may land before streaming
    expect(readings).toEqual([77]);
    expect(ctrl.battery).toBe(77);

    gate.resolve();
    await pending;
    ctrl.disconnect();
    expect(ctrl.battery).toBeNull(); // cleanup resets it

    t.emitBattery(42); // stale late reading
    expect(readings).toEqual([77]);
    expect(ctrl.battery).toBeNull();
  });

  test("duplicate transport disconnects collapse to one connectionchange", async () => {
    const { ctrl, t, states } = rig();
    await ctrl.connect();

    t.emitDisconnect();
    t.emitDisconnect(); // a buggy/racy transport double-fires
    ctrl.disconnect(); // and the app disconnects on top

    expect(states).toEqual(["pairing", "streaming", "disconnected"]);
  });
});

describe("reconnect through the transport", () => {
  test("drives transport.reconnect() and restarts the stream", async () => {
    const { ctrl, t, states } = rig();
    await ctrl.connect();
    t.emitDisconnect();
    expect(ctrl.state).toBe("disconnected");

    await ctrl.reconnect();
    expect(t.reconnectCount).toBe(1);
    expect(states).toEqual(["pairing", "streaming", "disconnected", "pairing", "streaming"]);
    // START was re-sent on the new session.
    expect(Array.from(t.rxWrites[1]!.data)).toEqual(Array.from(startCmd(104)));
  });

  test("a transport without reconnect() rejects with zero events", async () => {
    let handlers: Parameters<TrikiTransport["attach"]>[0] | null = null;
    const minimal: TrikiTransport = {
      attach: (h) => {
        handlers = h;
      },
      detach: () => {
        handlers = null;
      },
      connect: async () => {},
      writeRx: async () => {},
      writeCtrl: async () => {},
      hasLed: false,
      disconnect: () => {
        handlers?.onDisconnect();
      },
    };
    const ctrl = make({ fusion: "none", transport: minimal });
    const states: ConnectionState[] = [];
    ctrl.on("connectionchange", (s) => states.push(s));

    await expect(ctrl.reconnect()).rejects.toThrow("does not support reconnect");
    expect(states).toEqual([]);
  });
});

describe("transport ownership and validation", () => {
  test("the constructor rejects a malformed transport with a member list", () => {
    expect(() => make({ transport: {} as unknown as TrikiTransport })).toThrow(TypeError);
    expect(() => make({ transport: {} as unknown as TrikiTransport })).toThrow(
      /attach.*detach.*connect.*writeRx.*writeCtrl.*disconnect.*hasLed/,
    );
  });

  test("a second controller cannot silently claim an attached transport", () => {
    const t = new FakeTransport();
    make({ fusion: "none", transport: t });
    expect(() => make({ fusion: "none", transport: t })).toThrow("already attached");
  });
});
