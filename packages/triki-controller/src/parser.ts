/**
 * Motion-frame parser. Accumulates BLE notification chunks, finds the `0x22 0x00`
 * header, drops leading garbage, and emits complete 14-byte frames as raw int16
 * counts. Ported from the reference web controller's frame parser.
 */
import { HEADER0, HEADER1, FRAME_LEN } from "./protocol";

/** One decoded 14-byte frame as raw signed-16 sensor counts (no scaling applied). */
export interface RawFrame {
  gxRaw: number;
  gyRaw: number;
  gzRaw: number;
  axRaw: number;
  ayRaw: number;
  azRaw: number;
  /** The 14 frame bytes. */
  bytes: Uint8Array;
}

/** Decode a single 14-byte frame: int16 LE at offsets 2/4/6 (gyro) and 8/10/12 (accel). */
export function decodeCounts(frame: Uint8Array): RawFrame {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    gxRaw: dv.getInt16(2, true),
    gyRaw: dv.getInt16(4, true),
    gzRaw: dv.getInt16(6, true),
    axRaw: dv.getInt16(8, true),
    ayRaw: dv.getInt16(10, true),
    azRaw: dv.getInt16(12, true),
    bytes: frame,
  };
}

/** Stateful framer with a persistent buffer and header resync. */
export class FrameParser {
  #buf = new Uint8Array(0);

  /** Append a notification chunk; return every complete frame now decodable. */
  push(chunk: Uint8Array): RawFrame[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);
    this.#buf = merged;

    const frames: RawFrame[] = [];
    for (;;) {
      const j = this.#findHeader(this.#buf);
      if (j < 0) {
        // No header: a lone trailing 0x22 might be the first half of a split header,
        // so keep the last byte once the buffer grows past a notification's worth.
        if (this.#buf.length > 64) this.#buf = this.#buf.slice(this.#buf.length - 1);
        break;
      }
      if (j > 0) this.#buf = this.#buf.slice(j); // drop garbage before the header
      if (this.#buf.length < FRAME_LEN) break; // wait for a full frame
      const frame = this.#buf.slice(0, FRAME_LEN);
      this.#buf = this.#buf.slice(FRAME_LEN);
      frames.push(decodeCounts(frame));
    }
    return frames;
  }

  /** Drop buffered bytes (call on connect/disconnect). */
  reset(): void {
    this.#buf = new Uint8Array(0);
  }

  #findHeader(arr: Uint8Array): number {
    for (let i = 0; i + 1 < arr.length; i++) {
      if (arr[i] === HEADER0 && arr[i + 1] === HEADER1) return i;
    }
    return -1;
  }
}
