/**
 * 6-axis VQF orientation fusion (gyro + accel, no magnetometer).
 *
 * Algorithm ported from VQF by Daniel Laidig (https://github.com/dlaidig/vqf), MIT.
 * This is the "basic" 6-DoF variant: strapdown gyro integration corrected by an
 * accelerometer inclination estimate that is low-pass filtered with a 2nd-order
 * Butterworth (time constant `tauAcc`). It has no gyro-bias estimation, rest
 * detection, or magnetometer fusion.
 *
 * Drop-in compatible with {@link MadgwickAHRS}: identical `update / quaternion /
 * reset` shape and the same `[w, x, y, z]` right-handed convention. `update` takes
 * gyro in deg/s (converted internally) and accel in g — VQF normalizes the accel
 * vector, so its scale does not affect the output.
 */
import type { OrientationFilter, Quaternion } from "./fusion";

const DEG2RAD = Math.PI / 180;
const EPS = Number.EPSILON;
const SQRT2 = Math.SQRT2;

export interface VqfOptions {
  /** Accelerometer low-pass time constant in seconds. Default 2.0. */
  tauAcc?: number;
}

/** Default accelerometer low-pass time constant (seconds). */
export const DEFAULT_TAU_ACC = 2.0;

/**
 * Clamp `tauAcc` to a finite, non-negative value, falling back to the default for
 * NaN/Infinity/negative input (which would otherwise produce non-finite Butterworth
 * coefficients and poison the quaternion). `0` is valid — the filter degrades to a
 * pass-through.
 */
function sanitizeTauAcc(tau: number): number {
  return Number.isFinite(tau) && tau >= 0 ? tau : DEFAULT_TAU_ACC;
}

export class VqfAHRS implements OrientationFilter {
  #tauAcc: number;
  /** Sample period in seconds, fixed from the first {@link update}. */
  #ts: number | null = null;
  /** 2nd-order Butterworth coefficients (computed once `#ts` is known). */
  #b: number[] = [];
  #a: number[] = [];

  /** Gyro strapdown orientation and the accel inclination correction. */
  #gyrQuat: number[] = [1, 0, 0, 0];
  #accQuat: number[] = [1, 0, 0, 0];

  /** Low-pass state (2 per axis) used once initialization has settled. */
  #lpState: number[] = [0, 0, 0, 0, 0, 0];
  #lastAccLp: number[] = [0, 0, 0];

  /** Bootstrap: average the earth-frame accel over the first `tauAcc` seconds. */
  #initializing = true;
  #initCount = 0;
  #initSum: number[] = [0, 0, 0];

  constructor(options: VqfOptions = {}) {
    this.#tauAcc = sanitizeTauAcc(options.tauAcc ?? DEFAULT_TAU_ACC);
  }

  /** Accelerometer low-pass time constant (seconds). */
  get tauAcc(): number {
    return this.#tauAcc;
  }

  /**
   * Change the accel low-pass time constant live. Recomputes the Butterworth
   * coefficients from the current sample period without disturbing the orientation
   * state, so a tuning slider does not snap the model.
   */
  setTauAcc(tau: number): void {
    this.#tauAcc = sanitizeTauAcc(tau);
    if (this.#ts !== null) {
      const c = filterCoeffs(this.#tauAcc, this.#ts);
      this.#b = c.b;
      this.#a = c.a;
    }
  }

  /** Reset orientation to identity `[1, 0, 0, 0]` and re-bootstrap the accel filter. */
  reset(): void {
    this.#gyrQuat = [1, 0, 0, 0];
    this.#accQuat = [1, 0, 0, 0];
    this.#lpState = [0, 0, 0, 0, 0, 0];
    this.#lastAccLp = [0, 0, 0];
    this.#initializing = true;
    this.#initCount = 0;
    this.#initSum = [0, 0, 0];
    // #ts and the filter coefficients describe the sample rate, not the orientation.
  }

  /**
   * Advance the filter by one sample.
   * @param gxDeg gyro X in deg/s
   * @param gyDeg gyro Y in deg/s
   * @param gzDeg gyro Z in deg/s
   * @param ax accel X in g
   * @param ay accel Y in g
   * @param az accel Z in g
   * @param dt time step in seconds
   */
  update(
    gxDeg: number,
    gyDeg: number,
    gzDeg: number,
    ax: number,
    ay: number,
    az: number,
    dt: number,
  ): void {
    if (this.#ts === null) {
      this.#ts = dt;
      const c = filterCoeffs(this.#tauAcc, this.#ts);
      this.#b = c.b;
      this.#a = c.a;
    }
    this.#updateGyr(gxDeg * DEG2RAD, gyDeg * DEG2RAD, gzDeg * DEG2RAD, dt);
    this.#updateAcc(ax, ay, az);
  }

  /** Current fused orientation `[w, x, y, z]` = accQuat ∘ gyrQuat. */
  quaternion(): Quaternion {
    const out = [0, 0, 0, 0];
    quatMultiply(this.#accQuat, this.#gyrQuat, out);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
  }

  // --- internal ----------------------------------------------------------------

  /** Strapdown integration: rotate the gyro quaternion by the angular increment. */
  #updateGyr(gx: number, gy: number, gz: number, dt: number): void {
    const gyrNorm = Math.hypot(gx, gy, gz);
    if (gyrNorm > EPS) {
      const angle = gyrNorm * dt;
      const c = Math.cos(angle / 2);
      const s = Math.sin(angle / 2) / gyrNorm;
      const step = [c, s * gx, s * gy, s * gz];
      quatMultiply(this.#gyrQuat, step, this.#gyrQuat);
      normalize(this.#gyrQuat, 4);
    }
  }

  /** Inclination correction from the low-pass-filtered, earth-frame accelerometer. */
  #updateAcc(ax: number, ay: number, az: number): void {
    if (ax === 0 && ay === 0 && az === 0) return;

    const accEarth = [0, 0, 0];
    quatRotate(this.#gyrQuat, [ax, ay, az], accEarth); // body -> earth (gyro frame)
    this.#filterVec(accEarth); // writes this.#lastAccLp

    quatRotate(this.#accQuat, this.#lastAccLp, accEarth);
    normalize(accEarth, 3);

    // Shortest rotation that brings the filtered gravity estimate onto +Z.
    const corr = [1, 0, 0, 0];
    const qw = Math.sqrt((accEarth[2]! + 1) / 2);
    if (qw > 1e-6) {
      corr[0] = qw;
      corr[1] = (0.5 * accEarth[1]!) / qw;
      corr[2] = (-0.5 * accEarth[0]!) / qw;
      corr[3] = 0;
    } else {
      corr[0] = 0;
      corr[1] = 1;
      corr[2] = 0;
      corr[3] = 0;
    }
    quatMultiply(corr, this.#accQuat, this.#accQuat);
    normalize(this.#accQuat, 4);
  }

  /**
   * Low-pass the earth-frame accel into `#lastAccLp`. For the first `tauAcc`
   * seconds it accumulates a running mean, then seeds the Butterworth state from
   * that mean so the steady-state filter continues smoothly.
   */
  #filterVec(x: number[]): void {
    if (this.#initializing) {
      this.#initCount++;
      for (let i = 0; i < 3; i++) {
        this.#initSum[i]! += x[i]!;
        this.#lastAccLp[i] = this.#initSum[i]! / this.#initCount;
      }
      if (this.#initCount * this.#ts! >= this.#tauAcc) {
        for (let i = 0; i < 3; i++) {
          const [s0, s1] = filterInitialState(this.#lastAccLp[i]!, this.#b, this.#a);
          this.#lpState[2 * i] = s0;
          this.#lpState[2 * i + 1] = s1;
        }
        this.#initializing = false;
      }
      return;
    }
    for (let i = 0; i < 3; i++) {
      this.#lastAccLp[i] = filterStep(x[i]!, this.#b, this.#a, this.#lpState, 2 * i);
    }
  }
}

/** Hamilton product `out = q1 ∘ q2` (safe when `out` aliases `q1` or `q2`). */
function quatMultiply(q1: number[], q2: number[], out: number[]): void {
  const a0 = q1[0]!,
    a1 = q1[1]!,
    a2 = q1[2]!,
    a3 = q1[3]!;
  const b0 = q2[0]!,
    b1 = q2[1]!,
    b2 = q2[2]!,
    b3 = q2[3]!;
  out[0] = a0 * b0 - a1 * b1 - a2 * b2 - a3 * b3;
  out[1] = a0 * b1 + a1 * b0 + a2 * b3 - a3 * b2;
  out[2] = a0 * b2 - a1 * b3 + a2 * b0 + a3 * b1;
  out[3] = a0 * b3 + a1 * b2 - a2 * b1 + a3 * b0;
}

/** Rotate vector `v` by quaternion `q` into `out` (out must not alias v). */
function quatRotate(q: number[], v: number[], out: number[]): void {
  const w = q[0]!,
    x = q[1]!,
    y = q[2]!,
    z = q[3]!;
  const v0 = v[0]!,
    v1 = v[1]!,
    v2 = v[2]!;
  out[0] = (1 - 2 * y * y - 2 * z * z) * v0 + 2 * v1 * (y * x - w * z) + 2 * v2 * (w * y + z * x);
  out[1] = 2 * v0 * (w * z + y * x) + (1 - 2 * x * x - 2 * z * z) * v1 + 2 * v2 * (y * z - x * w);
  out[2] = 2 * v0 * (z * x - w * y) + 2 * v1 * (w * x + z * y) + (1 - 2 * x * x - 2 * y * y) * v2;
}

/** Euclidean norm of the first `n` components of `v`. */
function norm(v: number[], n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

/** Normalize the first `n` components of `v` in place (no-op for a zero vector). */
function normalize(v: number[], n: number): void {
  const m = norm(v, n);
  if (m < EPS) return;
  for (let i = 0; i < n; i++) v[i]! /= m;
}

/**
 * 2nd-order Butterworth low-pass coefficients (Direct Form II transposed) for time
 * constant `tau` and sample period `ts`. Degenerates to a pass-through when `tau`
 * is below half a sample.
 */
function filterCoeffs(tau: number, ts: number): { b: number[]; a: number[] } {
  if (tau < ts / 2) return { b: [1, 0, 0], a: [0, 0] };
  const fc = SQRT2 / (2 * Math.PI) / tau;
  const c = Math.tan(Math.PI * fc * ts);
  const d = c * c + SQRT2 * c + 1;
  const b0 = (c * c) / d;
  return {
    b: [b0, 2 * b0, b0],
    a: [(2 * (c * c - 1)) / d, (1 - SQRT2 * c + c * c) / d],
  };
}

/** Filter state that yields a steady output equal to the constant input `x0`. */
function filterInitialState(x0: number, b: number[], a: number[]): [number, number] {
  return [x0 * (1 - b[0]!), x0 * (b[2]! - a[1]!)];
}

/** One Direct Form II transposed step; advances `state[o..o+1]` and returns `y`. */
function filterStep(x: number, b: number[], a: number[], state: number[], o: number): number {
  const y = b[0]! * x + state[o]!;
  state[o] = b[1]! * x - a[0]! * y + state[o + 1]!;
  state[o + 1] = b[2]! * x - a[1]! * y;
  return y;
}
