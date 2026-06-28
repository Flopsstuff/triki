import { describe, test, expect } from "vitest";
import {
  MadgwickAHRS,
  AccelAHRS,
  quatMul,
  quatAboutZ,
  yawRadOf,
  eulerOf,
} from "./fusion";
import type { Quaternion } from "./fusion";

const norm = (q: Quaternion): number => Math.hypot(q[0], q[1], q[2], q[3]);
const DEG = Math.PI / 180;

describe("quaternion helpers", () => {
  test("quatMul: identity is neutral", () => {
    const q: Quaternion = [0.5, 0.5, -0.5, 0.5];
    expect(quatMul([1, 0, 0, 0], q)).toEqual(q);
    expect(quatMul(q, [1, 0, 0, 0])).toEqual(q);
  });

  test("quatMul: i ∘ j = k (Hamilton convention)", () => {
    expect(quatMul([0, 1, 0, 0], [0, 0, 1, 0])).toEqual([0, 0, 0, 1]);
  });

  test("quatMul: non-commutative (j ∘ i = -k)", () => {
    expect(quatMul([0, 0, 1, 0], [0, 1, 0, 0])).toEqual([0, 0, 0, -1]);
  });

  test("quatAboutZ round-trips through yawRadOf", () => {
    for (const rad of [-1.2, -0.3, 0, 0.5, 1.9]) {
      expect(yawRadOf(quatAboutZ(rad))).toBeCloseTo(rad, 10);
    }
  });

  test("eulerOf: identity is zero", () => {
    expect(eulerOf([1, 0, 0, 0])).toEqual({ roll: 0, pitch: 0, yaw: 0 });
  });

  test("eulerOf: pure roll / pitch / yaw rotations", () => {
    const roll = eulerOf([Math.cos(15 * DEG), Math.sin(15 * DEG), 0, 0]);
    expect(roll.roll).toBeCloseTo(30, 6);
    expect(roll.pitch).toBeCloseTo(0, 6);
    expect(roll.yaw).toBeCloseTo(0, 6);

    const pitch = eulerOf([Math.cos(10 * DEG), 0, Math.sin(10 * DEG), 0]);
    expect(pitch.pitch).toBeCloseTo(20, 6);
    expect(pitch.roll).toBeCloseTo(0, 6);

    const yaw = eulerOf(quatAboutZ(25 * DEG));
    expect(yaw.yaw).toBeCloseTo(25, 6);
  });

  test("eulerOf: pitch is clamped at ±90° (no NaN past the gimbal)", () => {
    const e = eulerOf([Math.cos(45 * DEG), 0, Math.sin(45 * DEG), 0]);
    expect(e.pitch).toBeCloseTo(90, 6);
    expect(Number.isNaN(e.pitch)).toBe(false);
  });
});

describe("MadgwickAHRS", () => {
  test("starts at identity and resets to it", () => {
    const m = new MadgwickAHRS();
    expect(m.quaternion()).toEqual([1, 0, 0, 0]);
    for (let i = 0; i < 50; i++) m.update(30, 10, -5, 0, 0, 1, 1 / 104);
    expect(m.quaternion()).not.toEqual([1, 0, 0, 0]);
    m.reset();
    expect(m.quaternion()).toEqual([1, 0, 0, 0]);
  });

  test("keeps the quaternion unit-norm across many updates", () => {
    const m = new MadgwickAHRS({ beta: 0.1 });
    for (let i = 0; i < 1000; i++) m.update(50, -30, 12, 0.1, -0.2, 0.97, 1 / 104);
    expect(norm(m.quaternion())).toBeCloseTo(1, 10);
  });

  test("converges to the accel tilt with zero gyro", () => {
    const ax = 0;
    const ay = 0.5;
    const az = Math.sqrt(1 - ay * ay); // unit gravity, ~30° roll about X
    const target = new AccelAHRS();
    target.update(0, 0, 0, ax, ay, az, 1 / 104);

    const m = new MadgwickAHRS({ beta: 0.3 });
    for (let i = 0; i < 6000; i++) m.update(0, 0, 0, ax, ay, az, 1 / 104);
    const e = m.euler();
    expect(Math.abs(e.roll - target.euler().roll)).toBeLessThan(1);
    expect(Math.abs(e.pitch - target.euler().pitch)).toBeLessThan(1);
    expect(e.yaw).toBeCloseTo(0, 6);
  });

  test("the zero-accel guard yields no NaN (gyro-only integration)", () => {
    const m = new MadgwickAHRS();
    for (let i = 0; i < 200; i++) m.update(45, 0, 0, 0, 0, 0, 1 / 104);
    const q = m.quaternion();
    expect(q.every((c) => Number.isFinite(c))).toBe(true);
    expect(norm(q)).toBeCloseTo(1, 10);
  });

  test("the zero-gradient (snorm) guard yields no NaN when already aligned", () => {
    // Identity orientation + gravity exactly on +Z makes the accel gradient zero,
    // so the snorm>0 branch is hit: normalizing a zero vector would poison q with NaN.
    const m = new MadgwickAHRS();
    for (let i = 0; i < 200; i++) m.update(0, 0, 0, 0, 0, 1, 1 / 104);
    const q = m.quaternion();
    expect(q.every((c) => Number.isFinite(c))).toBe(true);
    expect(norm(q)).toBeCloseTo(1, 10);
    expect(m.euler()).toEqual({ roll: 0, pitch: 0, yaw: 0 });
  });

  test("beta is mutable and euler() matches eulerOf(quaternion())", () => {
    const m = new MadgwickAHRS();
    m.beta = 0.2;
    expect(m.beta).toBe(0.2);
    m.update(10, 20, 30, 0.1, 0.2, 0.95, 1 / 104);
    expect(m.euler()).toEqual(eulerOf(m.quaternion()));
  });
});

describe("AccelAHRS", () => {
  test("flat gravity → identity", () => {
    const a = new AccelAHRS();
    a.update(0, 0, 0, 0, 0, 1, 0);
    expect(a.quaternion()).toEqual([1, 0, 0, 0]);
  });

  test("gravity along +X body → pitched -90°", () => {
    const a = new AccelAHRS();
    a.update(0, 0, 0, 1, 0, 0, 0);
    const e = a.euler();
    expect(e.pitch).toBeCloseTo(-90, 4);
    expect(e.yaw).toBe(0);
  });

  test("upside down → 180° about X", () => {
    const a = new AccelAHRS();
    a.update(0, 0, 0, 0, 0, -1, 0);
    expect(a.quaternion()).toEqual([0, 1, 0, 0]);
  });

  test("a zero-magnitude sample keeps the previous orientation", () => {
    const a = new AccelAHRS();
    a.update(0, 0, 0, 1, 0, 0, 0);
    const before = a.quaternion();
    a.update(99, 99, 99, 0, 0, 0, 1);
    expect(a.quaternion()).toEqual(before);
  });

  test("introduces no heading DOF (quaternion z stays 0) and ignores gyro", () => {
    // The accel-only solution never rotates about world Z, so q[3] is always 0...
    const a = new AccelAHRS();
    a.update(1000, -500, 250, 0.3, -0.4, 0.866, 1);
    expect(a.quaternion()[3]).toBe(0);

    // ...and the gyro inputs do not affect the result at all.
    const noGyro = new AccelAHRS();
    noGyro.update(0, 0, 0, 0.3, -0.4, 0.866, 1);
    expect(a.quaternion()).toEqual(noGyro.quaternion());
  });
});
