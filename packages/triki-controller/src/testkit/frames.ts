/** Test helpers for building motion frames. Lives under `src/testkit/` so it is
 * excluded from coverage and never bundled into `dist` (tsup follows `index.ts`). */
import { HEADER0, HEADER1 } from "../protocol";

/**
 * Build a single 14-byte motion frame: the `0x22 0x00` header followed by six int16
 * little-endian counts — gyro X/Y/Z at offsets 2/4/6 and accel X/Y/Z at 8/10/12.
 */
export function frame(
  gx: number,
  gy: number,
  gz: number,
  ax: number,
  ay: number,
  az: number,
): Uint8Array {
  const buf = new Uint8Array(14);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, HEADER0);
  dv.setUint8(1, HEADER1);
  dv.setInt16(2, gx, true);
  dv.setInt16(4, gy, true);
  dv.setInt16(6, gz, true);
  dv.setInt16(8, ax, true);
  dv.setInt16(10, ay, true);
  dv.setInt16(12, az, true);
  return buf;
}

/** Concatenate byte chunks into one `Uint8Array`. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
