/**
 * 6-axis Madgwick AHRS orientation fusion (gyro + accel, no magnetometer) plus
 * the quaternion helpers used for heading re-zeroing. Ported verbatim from the
 * reference web controller.
 *
 * All quaternions are `[w, x, y, z]` in the right-handed math frame. The display
 * page applies a left-handed CSS negation (`[w, x, -y, -z]`) for its 3D cube;
 * that is presentation-only and intentionally NOT part of this math.
 */

/** Orientation quaternion `[w, x, y, z]`, right-handed. */
export type Quaternion = readonly [w: number, x: number, y: number, z: number];

/** Tait-Bryan angles in degrees. */
export interface EulerAngles {
  roll: number;
  pitch: number;
  yaw: number;
}

export interface MadgwickOptions {
  /** Filter gain. Default 0.08. */
  beta?: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export class MadgwickAHRS {
  /** Filter gain. */
  readonly beta: number;
  #q: Quaternion = [1, 0, 0, 0];

  constructor(options: MadgwickOptions = {}) {
    this.beta = options.beta ?? 0.08;
  }

  /** Reset orientation to identity `[1, 0, 0, 0]`. */
  reset(): void {
    this.#q = [1, 0, 0, 0];
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
    let [q0, q1, q2, q3] = this.#q;
    const gx = gxDeg * DEG2RAD;
    const gy = gyDeg * DEG2RAD;
    const gz = gzDeg * DEG2RAD;

    // Rate of change of quaternion from the gyroscope.
    let qDot1 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qDot2 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qDot3 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qDot4 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    // Accelerometer correction (skip when the accel vector is zero / unusable).
    if (!(ax === 0 && ay === 0 && az === 0)) {
      let rn = 1 / Math.hypot(ax, ay, az);
      ax *= rn;
      ay *= rn;
      az *= rn;

      const _2q0 = 2 * q0;
      const _2q1 = 2 * q1;
      const _2q2 = 2 * q2;
      const _2q3 = 2 * q3;
      const _4q0 = 4 * q0;
      const _4q1 = 4 * q1;
      const _4q2 = 4 * q2;
      const _8q1 = 8 * q1;
      const _8q2 = 8 * q2;
      const q0q0 = q0 * q0;
      const q1q1 = q1 * q1;
      const q2q2 = q2 * q2;
      const q3q3 = q3 * q3;

      let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
      let s1 =
        _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
      let s2 =
        4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
      let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;

      // Guard the zero-gradient singularity (orientation already matches gravity):
      // normalizing a zero vector would poison the quaternion with NaN. Real device
      // data is noisy so this is never hit in practice, but synthetic/clean input can.
      const snorm = Math.hypot(s0, s1, s2, s3);
      if (snorm > 0) {
        rn = 1 / snorm;
        s0 *= rn;
        s1 *= rn;
        s2 *= rn;
        s3 *= rn;

        qDot1 -= this.beta * s0;
        qDot2 -= this.beta * s1;
        qDot3 -= this.beta * s2;
        qDot4 -= this.beta * s3;
      }
    }

    // Integrate and renormalize.
    q0 += qDot1 * dt;
    q1 += qDot2 * dt;
    q2 += qDot3 * dt;
    q3 += qDot4 * dt;

    const norm = 1 / Math.hypot(q0, q1, q2, q3);
    this.#q = [q0 * norm, q1 * norm, q2 * norm, q3 * norm];
  }

  /** Current orientation quaternion `[w, x, y, z]`. */
  quaternion(): Quaternion {
    return this.#q;
  }

  /** Current orientation as Tait-Bryan euler angles in degrees. */
  euler(): EulerAngles {
    return eulerOf(this.#q);
  }
}

/** Hamilton product `a ∘ b`. */
export function quatMul(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** Rotation about the world vertical (gravity / Madgwick world Z) — the heading DOF. */
export function quatAboutZ(rad: number): Quaternion {
  const h = rad / 2;
  return [Math.cos(h), 0, 0, Math.sin(h)];
}

/** Yaw (heading) of a quaternion, in radians. */
export function yawRadOf(q: Quaternion): number {
  const [w, x, y, z] = q;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/** Convert a quaternion to Tait-Bryan euler angles in degrees. */
export function eulerOf(q: Quaternion): EulerAngles {
  const [w, x, y, z] = q;
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * RAD2DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * RAD2DEG,
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * RAD2DEG,
  };
}
