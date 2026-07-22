/**
 * Unit coverage for sequence assignment, V1 and V2.
 *
 * The point of this file is the SPLIT: V1's `seq` continues from the restored
 * checkpoint, V2's `attempt_seq` always restarts at 1, and `run_seq` is never
 * assigned by the worker at all. Using either formula for the other record
 * version produces a stream nobody can verify, so both are pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  assertContiguousAttemptSeqs,
  AttemptSeqCounter,
  FIRST_ATTEMPT_SEQ,
  firstSeqForRun,
  formatRunSeqCursor,
  parseRunSeqCursor,
  SeqCounter,
} from "./seq";

// ── V1 — run-global seq ──────────────────────────────────────────────────────

describe("firstSeqForRun (V1)", () => {
  it("starts a fresh run at seq 1", () => {
    expect(firstSeqForRun({ checkpointSeq: 0 })).toBe(1);
  });

  it("resumes a checkpointed run at checkpointSeq + 1", () => {
    expect(firstSeqForRun({ checkpointSeq: 41 })).toBe(42);
  });
});

describe("SeqCounter (V1)", () => {
  it("assigns monotonically from its first seq", () => {
    const counter = new SeqCounter(6);
    expect([counter.assign(), counter.assign(), counter.assign()]).toEqual([
      6, 7, 8,
    ]);
  });
});

// ── V2 — attempt-local seq ───────────────────────────────────────────────────

describe("FIRST_ATTEMPT_SEQ", () => {
  it("is 1 — attempt_seq resets for every new attempt", () => {
    expect(FIRST_ATTEMPT_SEQ).toBe(1);
  });

  it("is NOT derived from a restored checkpoint, unlike V1's firstSeqForRun", () => {
    // A successor that restored a checkpoint at attempt_seq 41 still starts its
    // OWN stream at 1; the restored position travels as restore.attemptSeq on
    // the claim. This assertion is the whole reason the two helpers coexist.
    expect(FIRST_ATTEMPT_SEQ).toBe(1);
    expect(firstSeqForRun({ checkpointSeq: 41 })).toBe(42);
  });
});

describe("AttemptSeqCounter", () => {
  it("defaults to the first attempt sequence", () => {
    const counter = new AttemptSeqCounter();
    expect(counter.peek).toBe(FIRST_ATTEMPT_SEQ);
    expect(counter.assign()).toBe(1);
  });

  it("assigns a dense, contiguous run of sequences", () => {
    const counter = new AttemptSeqCounter();
    expect([
      counter.assign(),
      counter.assign(),
      counter.assign(),
      counter.assign(),
    ]).toEqual([1, 2, 3, 4]);
  });

  it("reports the last assigned sequence, and null before the first assign", () => {
    const counter = new AttemptSeqCounter();
    expect(counter.lastAssigned).toBeNull();
    counter.assign();
    counter.assign();
    expect(counter.lastAssigned).toBe(2);
    expect(counter.peek).toBe(3);
  });

  it("accepts an explicit resume point within one attempt", () => {
    const counter = new AttemptSeqCounter(5);
    expect(counter.assign()).toBe(5);
    expect(counter.assign()).toBe(6);
  });

  it("refuses a non-positive or non-integer first sequence", () => {
    expect(() => new AttemptSeqCounter(0)).toThrow(RangeError);
    expect(() => new AttemptSeqCounter(-1)).toThrow(RangeError);
    expect(() => new AttemptSeqCounter(1.5)).toThrow(RangeError);
    expect(() => new AttemptSeqCounter(Number.NaN)).toThrow(RangeError);
  });
});

describe("assertContiguousAttemptSeqs", () => {
  it("accepts a batch that starts where the attempt left off", () => {
    expect(() => assertContiguousAttemptSeqs(0, [1, 2, 3])).not.toThrow();
    expect(() => assertContiguousAttemptSeqs(7, [8, 9])).not.toThrow();
  });

  it("accepts an empty batch", () => {
    expect(() => assertContiguousAttemptSeqs(3, [])).not.toThrow();
  });

  it("refuses a hole inside the batch", () => {
    expect(() => assertContiguousAttemptSeqs(0, [1, 3])).toThrow(
      /index 1: expected 2, received 3/,
    );
  });

  it("refuses a batch that skips ahead of the lease pointer", () => {
    expect(() => assertContiguousAttemptSeqs(4, [6, 7])).toThrow(
      /index 0: expected 5, received 6/,
    );
  });

  it("refuses a batch that restarts behind the lease pointer", () => {
    expect(() => assertContiguousAttemptSeqs(4, [1])).toThrow(RangeError);
  });
});

// ── V2 — run-global cursor (decimal strings, bigint-safe) ────────────────────

describe("formatRunSeqCursor", () => {
  it("formats a bigint exactly, past 2^53", () => {
    expect(formatRunSeqCursor(9_007_199_254_740_993n)).toBe("9007199254740993");
  });

  it("formats a safe integer", () => {
    expect(formatRunSeqCursor(42)).toBe("42");
    expect(formatRunSeqCursor(0)).toBe("0");
  });

  it("refuses a number that has already lost precision", () => {
    // The failure this guard exists to prevent: silently handing a subscriber a
    // cursor that resumes at the wrong event, with no error anywhere.
    expect(() => formatRunSeqCursor(2 ** 53 + 1)).toThrow(RangeError);
    expect(() => formatRunSeqCursor(1.5)).toThrow(RangeError);
    expect(() => formatRunSeqCursor(-1)).toThrow(RangeError);
  });

  it("passes a well-formed decimal string through unchanged", () => {
    expect(formatRunSeqCursor("9007199254740993")).toBe("9007199254740993");
    expect(formatRunSeqCursor("0")).toBe("0");
  });

  it("refuses a string that is not an exact decimal integer", () => {
    expect(() => formatRunSeqCursor("007")).toThrow(RangeError);
    expect(() => formatRunSeqCursor("1e3")).toThrow(RangeError);
    expect(() => formatRunSeqCursor("")).toThrow(RangeError);
    expect(() => formatRunSeqCursor("-4")).toThrow(RangeError);
  });
});

describe("parseRunSeqCursor", () => {
  it("treats an absent Last-Event-ID as a fresh subscription", () => {
    expect(parseRunSeqCursor(null)).toBe(0n);
    expect(parseRunSeqCursor(undefined)).toBe(0n);
    expect(parseRunSeqCursor("")).toBe(0n);
  });

  it("parses an exact decimal cursor past 2^53", () => {
    expect(parseRunSeqCursor("9007199254740993")).toBe(9_007_199_254_740_993n);
  });

  it("refuses a malformed cursor rather than silently replaying the run", () => {
    expect(() => parseRunSeqCursor("abc")).toThrow(RangeError);
    expect(() => parseRunSeqCursor("12.5")).toThrow(RangeError);
    expect(() => parseRunSeqCursor("007")).toThrow(RangeError);
  });

  it("round-trips with formatRunSeqCursor", () => {
    const value = "18446744073709551615";
    expect(formatRunSeqCursor(parseRunSeqCursor(value))).toBe(value);
  });
});
