import { describe, expect, it } from "vitest";
import {
  RUN_SUMMARY_MAX_CHARS,
  deriveFanoutStatus,
  deriveRunSummary,
} from "./agent.execute-subagent";

describe("deriveRunSummary", () => {
  it("prefers a top-level summary field, trimmed", () => {
    expect(
      deriveRunSummary({ summary: "  did the thing  ", rest: "x".repeat(500) }),
    ).toBe("did the thing");
  });

  it("falls back message → text in precedence order", () => {
    expect(deriveRunSummary({ message: "m", text: "t" })).toBe("m");
    expect(deriveRunSummary({ text: "t" })).toBe("t");
  });

  it("ignores empty/whitespace declared fields", () => {
    expect(deriveRunSummary({ summary: "   ", message: "real" })).toBe("real");
  });

  it("truncates the declared field to the budget", () => {
    expect(deriveRunSummary({ summary: "s".repeat(1000) })).toHaveLength(
      RUN_SUMMARY_MAX_CHARS,
    );
  });

  it("falls back to truncated JSON for outputs with no declared field", () => {
    expect(deriveRunSummary({ results: [1, 2] })).toBe(
      JSON.stringify({ results: [1, 2] }),
    );
    expect(deriveRunSummary({ blob: "x".repeat(1000) })).toHaveLength(
      RUN_SUMMARY_MAX_CHARS,
    );
  });

  it("handles arrays and scalars via JSON fallback", () => {
    expect(deriveRunSummary(["a", "b"])).toBe('["a","b"]');
    expect(deriveRunSummary(42)).toBe("42");
  });

  it("returns empty string for null/undefined and unserializable outputs", () => {
    expect(deriveRunSummary(null)).toBe("");
    expect(deriveRunSummary(undefined)).toBe("");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(deriveRunSummary(cyclic)).toBe("");
  });
});

describe("deriveFanoutStatus", () => {
  it("returns 'completed' when all children succeed", () => {
    expect(deriveFanoutStatus(3, 3, false)).toBe("completed");
  });

  it("returns 'completed' for empty fanout (zero runs)", () => {
    // 0 === 0, no failures
    expect(deriveFanoutStatus(0, 0, false)).toBe("completed");
  });

  it("returns 'failed' when all children fail (regression: was 'completed' before fix)", () => {
    // completed=0, total=3, anyFailed=true → must be "failed", not "completed"
    expect(deriveFanoutStatus(0, 3, true)).toBe("failed");
  });

  it("returns 'partial' when some children succeed and some fail", () => {
    expect(deriveFanoutStatus(1, 3, true)).toBe("partial");
    expect(deriveFanoutStatus(2, 3, true)).toBe("partial");
  });

  it("returns 'completed' for single successful child", () => {
    expect(deriveFanoutStatus(1, 1, false)).toBe("completed");
  });

  it("returns 'failed' for single failed child (regression case)", () => {
    expect(deriveFanoutStatus(0, 1, true)).toBe("failed");
  });
});
