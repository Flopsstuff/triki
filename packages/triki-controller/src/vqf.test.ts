import { describe, test, expect } from "vitest";
import { VqfAHRS, DEFAULT_TAU_ACC } from "./vqf";
import { AccelAHRS, eulerOf } from "./fusion";
import type { Quaternion } from "./fusion";

const norm = (q: Quaternion): number => Math.hypot(q[0], q[1], q[2], q[3]);

describe("VqfAHRS", () => {
  test("DEFAULT_TAU_ACC is 2.0 s and is the default", () => {
    expect(DEFAULT_TAU_ACC).toBe(2.0);
    expect(new VqfAHRS().tauAcc).toBe(2.0);
  });

  test("reports identity before any update", () => {
    expect(new VqfAHRS().quaternion()).toEqual([1, 0, 0, 0]);
  });

  test("keeps the quaternion unit-norm and NaN-free across many updates", () => {
    const v = new VqfAHRS({ tauAcc: 0.5 });
    for (let i = 0; i < 1000; i++) v.update(40, -20, 15, 0.1, -0.2, 0.97, 1 / 104);
    const q = v.quaternion();
    expect(q.every((c) => Number.isFinite(c))).toBe(true);
    expect(norm(q)).toBeCloseTo(1, 8);
  });

  test("frame parity: settles to the same tilt as AccelAHRS on steady gravity", () => {
    const ax = 0;
    const ay = 0.5;
    const az = Math.sqrt(1 - ay * ay); // ~30° roll about X
    const target = new AccelAHRS();
    target.update(0, 0, 0, ax, ay, az, 1 / 104);

    const v = new VqfAHRS({ tauAcc: 0.1 });
    for (let i = 0; i < 4000; i++) v.update(0, 0, 0, ax, ay, az, 1 / 104);
    const e = eulerOf(v.quaternion());
    expect(Math.abs(e.roll - target.euler().roll)).toBeLessThan(2);
    expect(Math.abs(e.pitch - target.euler().pitch)).toBeLessThan(2);
  });

  test("setTauAcc retunes live without throwing and updates the getter", () => {
    const v = new VqfAHRS({ tauAcc: 1 });
    v.update(0, 0, 0, 0, 0, 1, 1 / 104); // fixes the sample period
    v.setTauAcc(0.5);
    expect(v.tauAcc).toBe(0.5);
    expect(() => v.update(0, 0, 0, 0, 0, 1, 1 / 104)).not.toThrow();
  });

  test("reset() re-bootstraps to identity", () => {
    const v = new VqfAHRS({ tauAcc: 0.1 });
    for (let i = 0; i < 500; i++) v.update(0, 0, 0, 0, 0.5, 0.866, 1 / 104);
    expect(v.quaternion()).not.toEqual([1, 0, 0, 0]);
    v.reset();
    expect(v.quaternion()).toEqual([1, 0, 0, 0]);
  });
});
