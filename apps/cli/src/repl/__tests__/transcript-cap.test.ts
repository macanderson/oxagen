import { describe, it, expect } from "vitest";
import { capTranscript, MAX_TRANSCRIPT_MESSAGES } from "../transcript-cap.js";

describe("capTranscript", () => {
  it("returns the SAME array reference when within the cap (identity preserved)", () => {
    const list = [1, 2, 3];
    expect(capTranscript(list, 5)).toBe(list);
  });

  it("returns the same array when exactly at the cap", () => {
    const list = [1, 2, 3];
    expect(capTranscript(list, 3)).toBe(list);
  });

  it("keeps the most recent entries, dropping the oldest", () => {
    expect(capTranscript([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it("preserves the identity of retained objects (memo stays effective)", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const out = capTranscript([a, b, c], 2);
    expect(out).toEqual([b, c]);
    expect(out[0]).toBe(b);
    expect(out[1]).toBe(c);
  });

  it("returns an empty array for a non-positive cap", () => {
    expect(capTranscript([1, 2, 3], 0)).toEqual([]);
    expect(capTranscript([1, 2, 3], -4)).toEqual([]);
  });

  it("defaults to MAX_TRANSCRIPT_MESSAGES and leaves shorter lists untouched", () => {
    const list = Array.from({ length: MAX_TRANSCRIPT_MESSAGES }, (_, i) => i);
    expect(capTranscript(list)).toBe(list);
    const over = [...list, MAX_TRANSCRIPT_MESSAGES];
    const capped = capTranscript(over);
    expect(capped).toHaveLength(MAX_TRANSCRIPT_MESSAGES);
    expect(capped[capped.length - 1]).toBe(MAX_TRANSCRIPT_MESSAGES);
    expect(capped[0]).toBe(1); // the very first (0) was dropped
  });
});
