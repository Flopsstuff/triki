import { describe, test, expect } from "vitest";
import { FrameParser, decodeCounts } from "./parser";
import { FRAME_LEN } from "./protocol";
import { frame, concat } from "./testkit/frames";

describe("decodeCounts", () => {
  test("reads int16 LE at the gyro (2/4/6) and accel (8/10/12) offsets", () => {
    const f = frame(1, -2, 3, -4, 5, -6);
    const rf = decodeCounts(f);
    expect(rf.gxRaw).toBe(1);
    expect(rf.gyRaw).toBe(-2);
    expect(rf.gzRaw).toBe(3);
    expect(rf.axRaw).toBe(-4);
    expect(rf.ayRaw).toBe(5);
    expect(rf.azRaw).toBe(-6);
    expect(rf.bytes).toBe(f);
  });

  test("decodes full-range two's-complement values", () => {
    const rf = decodeCounts(frame(-1, 32767, -32768, 0, -32768, 32767));
    expect(rf.gxRaw).toBe(-1);
    expect(rf.gyRaw).toBe(32767);
    expect(rf.gzRaw).toBe(-32768);
    expect(rf.ayRaw).toBe(-32768);
    expect(rf.azRaw).toBe(32767);
  });

  test("honours byteOffset/byteLength when the frame is a subarray view", () => {
    const big = concat(new Uint8Array([0xaa, 0xbb, 0xcc]), frame(7, 8, 9, 10, 11, 12));
    const view = big.subarray(3, 3 + FRAME_LEN);
    const rf = decodeCounts(view);
    expect([rf.gxRaw, rf.gyRaw, rf.gzRaw, rf.axRaw, rf.ayRaw, rf.azRaw]).toEqual([7, 8, 9, 10, 11, 12]);
  });
});

describe("FrameParser.push", () => {
  test("decodes a single clean frame", () => {
    const p = new FrameParser();
    const out = p.push(frame(10, 20, 30, 40, 50, 60));
    expect(out).toHaveLength(1);
    expect([out[0]!.gxRaw, out[0]!.azRaw]).toEqual([10, 60]);
  });

  test("decodes multiple frames in one chunk", () => {
    const p = new FrameParser();
    const out = p.push(concat(frame(1, 0, 0, 0, 0, 0), frame(2, 0, 0, 0, 0, 0), frame(3, 0, 0, 0, 0, 0)));
    expect(out.map((f) => f.gxRaw)).toEqual([1, 2, 3]);
  });

  test("reassembles a frame split across two chunks", () => {
    const p = new FrameParser();
    const f = frame(123, 0, 0, 0, 0, 0);
    expect(p.push(f.subarray(0, 8))).toHaveLength(0);
    const out = p.push(f.subarray(8));
    expect(out).toHaveLength(1);
    expect(out[0]!.gxRaw).toBe(123);
  });

  test("resyncs past leading garbage to find the header", () => {
    const p = new FrameParser();
    const out = p.push(concat(new Uint8Array([0x00, 0x99, 0x11]), frame(55, 0, 0, 0, 0, 0)));
    expect(out).toHaveLength(1);
    expect(out[0]!.gxRaw).toBe(55);
  });

  test("ignores a 0x22 that is not followed by 0x00", () => {
    const p = new FrameParser();
    // 0x22 0x01 is not a header; the real frame after it must still be found.
    const out = p.push(concat(new Uint8Array([0x22, 0x01]), frame(77, 0, 0, 0, 0, 0)));
    expect(out).toHaveLength(1);
    expect(out[0]!.gxRaw).toBe(77);
  });

  test("retains a lone trailing 0x22 as a possible split-header half", () => {
    const p = new FrameParser();
    const f1 = frame(1, 0, 0, 0, 0, 0);
    const f2 = frame(2, 0, 0, 0, 0, 0);
    // f1, then the first header byte of f2.
    expect(p.push(concat(f1, f2.subarray(0, 1))).map((f) => f.gxRaw)).toEqual([1]);
    // Deliver the rest of f2; the retained 0x22 completes the header.
    expect(p.push(f2.subarray(1)).map((f) => f.gxRaw)).toEqual([2]);
  });

  test("trims unbounded garbage to its last byte (>64 bytes, no header)", () => {
    const p = new FrameParser();
    // 64 non-header bytes + a trailing 0x22 (potential split header) = 65 bytes.
    const garbage = concat(new Uint8Array(64).fill(0x11), new Uint8Array([0x22]));
    expect(p.push(garbage)).toHaveLength(0);
    // The retained 0x22 + the remainder of a frame forms one valid frame.
    const f = frame(99, 0, 0, 0, 0, 0);
    const out = p.push(f.subarray(1));
    expect(out).toHaveLength(1);
    expect(out[0]!.gxRaw).toBe(99);
  });

  test("reset() drops the buffered partial frame", () => {
    const p = new FrameParser();
    const f = frame(42, 0, 0, 0, 0, 0);
    p.push(f.subarray(0, 8));
    p.reset();
    // The earlier half is gone; pushing the tail alone yields nothing.
    expect(p.push(f.subarray(8))).toHaveLength(0);
    // A subsequent whole frame parses cleanly.
    expect(p.push(frame(43, 0, 0, 0, 0, 0))).toHaveLength(1);
  });
});
