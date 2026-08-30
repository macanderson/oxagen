/**
 * Unit tests for the OXAGEN column-by-column reveal sequencing (see
 * init-reveal.ts). Pure frame function, tested the same way
 * repl/components.tsx's renderInvadersLane is: exact fixtures at chosen
 * column counts, plus monotonicity/idempotence properties.
 */
import { describe, it, expect } from "vitest";
import { WORDMARK } from "../banner.js";
import {
  revealFrame,
  isRevealComplete,
  WORDMARK_WIDTH,
} from "../init-reveal.js";

describe("WORDMARK_WIDTH", () => {
  it("matches the longest banner.tsx WORDMARK line", () => {
    expect(WORDMARK_WIDTH).toBe(Math.max(...WORDMARK.map((l) => l.length)));
    expect(WORDMARK_WIDTH).toBeGreaterThan(0);
  });
});

describe("revealFrame", () => {
  it("is fully blank at 0 columns revealed, but keeps the full line width", () => {
    const frame = revealFrame(0);
    expect(frame.length).toBe(WORDMARK.length);
    for (let i = 0; i < frame.length; i++) {
      expect(frame[i]).toBe(" ".repeat(WORDMARK[i]!.length));
    }
  });

  it("exactly matches WORDMARK once every column is revealed", () => {
    expect(revealFrame(WORDMARK_WIDTH)).toEqual(WORDMARK);
  });

  it("reveals only the leftmost N columns, left to right", () => {
    const n = 10;
    const frame = revealFrame(n);
    for (let i = 0; i < frame.length; i++) {
      const line = WORDMARK[i]!;
      expect(frame[i]!.slice(0, n)).toBe(line.slice(0, n));
      expect(frame[i]!.slice(n)).toBe(" ".repeat(line.length - n));
    }
  });

  it("never changes line width across partial reveals", () => {
    for (const n of [0, 1, 5, 25, WORDMARK_WIDTH]) {
      const frame = revealFrame(n);
      for (let i = 0; i < frame.length; i++) {
        expect(frame[i]!.length).toBe(WORDMARK[i]!.length);
      }
    }
  });

  it("clamps beyond the full width to the complete wordmark", () => {
    expect(revealFrame(WORDMARK_WIDTH + 50)).toEqual(WORDMARK);
  });

  it("clamps below 0 to fully blank", () => {
    expect(revealFrame(-5)).toEqual(revealFrame(0));
  });

  it("is monotonic: revealing more columns never erases previously revealed ones", () => {
    const a = revealFrame(8);
    const b = revealFrame(16);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.slice(0, 8)).toBe(a[i]!.slice(0, 8));
    }
  });

  it("is deterministic: the same column count always renders the same frame", () => {
    expect(revealFrame(12)).toEqual(revealFrame(12));
  });
});

describe("isRevealComplete", () => {
  it("is false until every column is revealed", () => {
    expect(isRevealComplete(0)).toBe(false);
    expect(isRevealComplete(WORDMARK_WIDTH - 1)).toBe(false);
  });

  it("is true at and beyond the full width", () => {
    expect(isRevealComplete(WORDMARK_WIDTH)).toBe(true);
    expect(isRevealComplete(WORDMARK_WIDTH + 10)).toBe(true);
  });
});
