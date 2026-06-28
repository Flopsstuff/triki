import { describe, test, expect, vi, afterEach } from "vitest";
import { TrikiController } from "./controller";
import { MadgwickAHRS, AccelAHRS } from "./fusion";
import { VqfAHRS } from "./vqf";
import { startCmd } from "./protocol";
import { makeFakeBluetooth } from "./testkit/fakeBle";
import type { FakeBleHandles, FakeBleOptions } from "./testkit/fakeBle";
import { frame } from "./testkit/frames";
import type {
  ConnectionState,
  FrameEvent,
  OrientationEvent,
  TrikiControllerOptions,
} from "./events";

const created: TrikiController[] = [];

/** Construct a controller and track it so afterEach tears down its rate timer. */
function make(options?: TrikiControllerOptions): TrikiController {
  const c = new TrikiController(options);
  created.push(c);
  return c;
}

/** Wire a fake stack and expose it on `navigator.bluetooth`. */
function install(fakeOptions?: FakeBleOptions): FakeBleHandles {
  const handles = makeFakeBluetooth(fakeOptions);
  vi.stubGlobal("navigator", { bluetooth: handles.bluetooth });
  return handles;
}

/** Let best-effort async work (e.g. the battery probe) settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const bytes = (u: Uint8Array): number[] => Array.from(u);

/** Last element (the package targets ES2020, so `Array.prototype.at` is unavailable). */
const last = <T>(a: T[]): T => a[a.length - 1]!;

afterEach(() => {
  for (const c of created.splice(0)) c.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fusion option resolution", () => {
  test("maps the constructor option to an algorithm and filter", () => {
    expect(make().fusionAlgorithm).toBe("madgwick");
    expect(make().fusion).toBeInstanceOf(MadgwickAHRS);
    expect(make({ fusion: true }).fusion).toBeInstanceOf(MadgwickAHRS);

    const off = make({ fusion: false });
    expect(off.fusionAlgorithm).toBe("none");
    expect(off.fusion).toBeUndefined();

    expect(make({ fusion: "vqf" }).fusion).toBeInstanceOf(VqfAHRS);
    expect(make({ fusion: "accel" }).fusion).toBeInstanceOf(AccelAHRS);
    expect(make({ fusion: "none" }).fusion).toBeUndefined();
  });
});

describe("isSupported", () => {
  test("reflects whether navigator.bluetooth exists", () => {
    vi.stubGlobal("navigator", {});
    expect(TrikiController.isSupported()).toBe(false);
    install();
    expect(TrikiController.isSupported()).toBe(true);
  });
});

describe("connect + frame pipeline", () => {
  test("writes START, transitions state, and decodes frames into events", async () => {
    const h = install();
    const ctrl = make({ fusion: "madgwick" });
    const states: ConnectionState[] = [];
    ctrl.on("connectionchange", (s) => states.push(s));

    await ctrl.connect();

    expect(states).toEqual(["pairing", "streaming"]);
    expect(ctrl.isConnected).toBe(true);
    expect(bytes(h.rx.writes[0]!)).toEqual(bytes(startCmd(104)));
    expect(h.tx.startNotificationsCount).toBe(1);

    const frames: FrameEvent[] = [];
    const orientations: OrientationEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));
    ctrl.on("orientation", (e) => orientations.push(e));

    h.tx.notify(frame(14286, 0, -14286, 0, 0, 2048));

    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.raw).toEqual({ gx: 14286, gy: 0, gz: -14286, ax: 0, ay: 0, az: 2048 });
    expect(f.gyro.x).toBeCloseTo(1000, 3);
    expect(f.gyro.z).toBeCloseTo(-1000, 3);
    expect(f.accel.z).toBeCloseTo(1, 6);

    expect(orientations).toHaveLength(1);
    expect(orientations[0]!.algorithm).toBe("madgwick");
    expect(orientations[0]!.quaternion).toHaveLength(4);
    expect(orientations[0]!.euler).toHaveProperty("roll");
  });
});

describe("bias and scale", () => {
  test("subtracts gyro/accel bias and honours gyro scale", async () => {
    const h = install();
    const ctrl = make({
      fusion: "none",
      gyroBias: { x: 1, y: 2, z: 3 },
      accelBias: { x: 0.1, y: 0, z: 0 },
    });
    await ctrl.connect();

    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));

    h.tx.notify(frame(0, 0, 0, 0, 0, 2048));
    let f = last(frames);
    expect(f.gyro.x).toBeCloseTo(-1, 6);
    expect(f.gyro.y).toBeCloseTo(-2, 6);
    expect(f.gyro.z).toBeCloseTo(-3, 6);
    expect(f.accel.x).toBeCloseTo(-0.1, 6);
    expect(f.accel.z).toBeCloseTo(1, 6);

    ctrl.setGyroBias({ x: 0, y: 0, z: 0 });
    ctrl.setAccelBias({ x: 0, y: 0, z: 0 });
    h.tx.notify(frame(0, 0, 0, 0, 0, 2048));
    f = last(frames);
    expect(f.gyro.x).toBeCloseTo(0, 6);
    expect(f.accel.x).toBeCloseTo(0, 6);

    ctrl.setGyroScale(1);
    h.tx.notify(frame(100, 0, 0, 0, 0, 0));
    expect(last(frames).gyro.x).toBeCloseTo(100, 6);
  });
});

describe("runtime fusion controls", () => {
  test("setFusion swaps the filter and gates orientation events", async () => {
    const h = install();
    const ctrl = make({ fusion: "madgwick" });
    await ctrl.connect();

    expect(ctrl.fusion).toBeInstanceOf(MadgwickAHRS);
    ctrl.setFusion("vqf");
    expect(ctrl.fusion).toBeInstanceOf(VqfAHRS);
    expect(ctrl.fusionAlgorithm).toBe("vqf");
    ctrl.setFusion("accel");
    expect(ctrl.fusion).toBeInstanceOf(AccelAHRS);

    ctrl.setFusion("none");
    expect(ctrl.fusion).toBeUndefined();
    const orientations: OrientationEvent[] = [];
    ctrl.on("orientation", (e) => orientations.push(e));
    h.tx.notify(frame(0, 0, 0, 0, 0, 2048));
    expect(orientations).toHaveLength(0);
  });

  test("setBeta and setTauAcc tune the live filter", () => {
    install();
    const ctrl = make({ fusion: "madgwick" });
    ctrl.setBeta(0.25);
    expect((ctrl.fusion as MadgwickAHRS).beta).toBe(0.25);

    ctrl.setFusion("vqf");
    ctrl.setTauAcc(0.5);
    expect((ctrl.fusion as VqfAHRS).tauAcc).toBe(0.5);
  });

  test("resetHeading is a no-op without fusion", () => {
    install();
    const ctrl = make({ fusion: "none" });
    expect(() => ctrl.resetHeading()).not.toThrow();
  });

  test("resetHeading re-zeroes the emitted heading", async () => {
    const h = install();
    const ctrl = make({ fusion: "madgwick" });
    await ctrl.connect();

    const orientations: OrientationEvent[] = [];
    ctrl.on("orientation", (e) => orientations.push(e));

    // First frame after connect integrates at a deterministic dt = 1/rateHz, so a
    // strong z-gyro yields a known non-zero heading.
    h.tx.notify(frame(0, 0, 14286, 0, 0, 2048));
    expect(Math.abs(last(orientations).euler.yaw)).toBeGreaterThan(1);

    ctrl.resetHeading();
    h.tx.notify(frame(0, 0, 0, 0, 0, 2048));
    expect(Math.abs(last(orientations).euler.yaw)).toBeLessThan(1);
  });
});

describe("battery", () => {
  test("reads the level on connect and tracks notifications", async () => {
    const h = install({ batteryLevel: 87 });
    const ctrl = make({ fusion: "none" });
    const firstBattery = new Promise<number>((resolve) => ctrl.on("battery", resolve));

    await ctrl.connect();
    expect(await firstBattery).toBe(87);
    expect(ctrl.battery).toBe(87);

    // The notification subscription is set up just after the initial read; let it land.
    await flush();
    h.battery!.notifyByte(42);
    expect(ctrl.battery).toBe(42);
  });

  test("tolerates a token without the Battery service", async () => {
    install({ battery: false });
    const ctrl = make({ fusion: "none" });
    const onBattery = vi.fn();
    ctrl.on("battery", onBattery);

    await ctrl.connect();
    await flush();

    expect(ctrl.battery).toBeNull();
    expect(onBattery).not.toHaveBeenCalled();
  });
});

describe("LED and rate commands", () => {
  test("setLed writes the control byte", async () => {
    const h = install({ led: true });
    const ctrl = make({ fusion: "none" });
    await ctrl.connect();

    expect(ctrl.hasLed).toBe(true);
    await ctrl.setLed(true);
    await ctrl.setLed(false);
    expect(h.ctrl!.writes.map(bytes)).toEqual([[0x01], [0x00]]);
  });

  test("setLed throws when the LED characteristic is absent", async () => {
    install({ led: false });
    const ctrl = make({ fusion: "none" });
    await ctrl.connect();

    expect(ctrl.hasLed).toBe(false);
    await expect(ctrl.setLed(true)).rejects.toThrow();
  });

  test("setRate stores before connect and re-sends START while streaming", async () => {
    const h = install();
    const ctrl = make({ fusion: "none" });

    await ctrl.setRate(52);
    expect(ctrl.rateHz).toBe(52);

    await ctrl.connect();
    expect(bytes(h.rx.writes[0]!)).toEqual(bytes(startCmd(52)));

    await ctrl.setRate(208);
    expect(ctrl.rateHz).toBe(208);
    expect(bytes(last(h.rx.writes))).toEqual(bytes(startCmd(208)));
  });
});

describe("lifecycle", () => {
  test("disconnect cleans up, emits disconnected, and stops handling frames", async () => {
    const h = install();
    const ctrl = make({ fusion: "none" });
    const states: ConnectionState[] = [];
    ctrl.on("connectionchange", (s) => states.push(s));

    await ctrl.connect();
    ctrl.disconnect();

    expect(ctrl.isConnected).toBe(false);
    expect(ctrl.state).toBe("disconnected");
    expect(states).toEqual(["pairing", "streaming", "disconnected"]);

    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));
    h.tx.notify(frame(1, 0, 0, 0, 0, 0));
    expect(frames).toHaveLength(0);
  });

  test("a remote gattserverdisconnected tears the session down", async () => {
    const h = install();
    const ctrl = make({ fusion: "none" });
    await ctrl.connect();
    expect(ctrl.isConnected).toBe(true);

    h.gatt.disconnect(); // simulate the peripheral dropping the link
    expect(ctrl.state).toBe("disconnected");
  });
});

describe("rate measurement", () => {
  test("emits frames-per-second roughly once per second", async () => {
    vi.useFakeTimers();
    const h = install();
    const ctrl = make({ fusion: "none" });
    await ctrl.connect();

    const rates: number[] = [];
    ctrl.on("rate", (r) => rates.push(r));
    for (let i = 0; i < 5; i++) h.tx.notify(frame(0, 0, 0, 0, 0, 2048));

    vi.advanceTimersByTime(1000);
    expect(last(rates)).toBe(5);
  });
});

describe("input hardening", () => {
  test("ignores a non-finite or non-positive gyro scale", async () => {
    const h = install();
    // 0 in the constructor falls back to the default scale (no div-by-zero).
    const ctrl = make({ fusion: "none", gyroScale: 0 });
    await ctrl.connect();

    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));

    h.tx.notify(frame(14286, 0, 0, 0, 0, 0));
    expect(last(frames).gyro.x).toBeCloseTo(1000, 3); // 14286 / 14.286, not Infinity

    ctrl.setGyroScale(1);
    h.tx.notify(frame(100, 0, 0, 0, 0, 0));
    expect(last(frames).gyro.x).toBeCloseTo(100, 3);

    // Bad values are rejected and the previous scale stands.
    ctrl.setGyroScale(0);
    ctrl.setGyroScale(NaN);
    h.tx.notify(frame(100, 0, 0, 0, 0, 0));
    expect(last(frames).gyro.x).toBeCloseTo(100, 3);
  });

  test("stores a defensive copy of bias and coerces non-finite axes to 0", async () => {
    const h = install();
    const bias = { x: 1, y: 2, z: 3 };
    const ctrl = make({ fusion: "none", gyroBias: bias });
    await ctrl.connect();

    const frames: FrameEvent[] = [];
    ctrl.on("frame", (e) => frames.push(e));

    bias.x = 999; // mutating the caller's object must not affect the controller
    h.tx.notify(frame(0, 0, 0, 0, 0, 0));
    expect(last(frames).gyro.x).toBeCloseTo(-1, 6); // used the stored copy (1)

    ctrl.setGyroBias({ x: NaN, y: 5, z: Infinity });
    h.tx.notify(frame(0, 0, 0, 0, 0, 0));
    const f = last(frames);
    expect(f.gyro.x).toBeCloseTo(0, 6); // NaN -> 0
    expect(f.gyro.y).toBeCloseTo(-5, 6);
    expect(f.gyro.z).toBeCloseTo(0, 6); // Infinity -> 0
  });

  test("setRate while VQF is active realigns the sample period and re-sends START", async () => {
    const h = install();
    const ctrl = make({ fusion: "vqf" });
    await ctrl.connect();

    await ctrl.setRate(208);
    expect(ctrl.rateHz).toBe(208);
    expect(bytes(last(h.rx.writes))).toEqual(bytes(startCmd(208)));

    const orientations: OrientationEvent[] = [];
    ctrl.on("orientation", (e) => orientations.push(e));
    h.tx.notify(frame(0, 0, 0, 0, 0, 2048));
    expect(last(orientations).quaternion.every((c) => Number.isFinite(c))).toBe(true);
  });
});
