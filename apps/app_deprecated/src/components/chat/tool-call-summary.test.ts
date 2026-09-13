/**
 * tool-call-summary.test.ts
 *
 * Tests the pure one-liner extractor: priority ordering, truncation, the
 * id-of-last-resort fallback, and the null cases (nothing salient / unparsed
 * partial JSON).
 */

import { describe, it, expect } from "vitest";
import { toolCallSummary } from "./tool-call-summary";

describe("toolCallSummary", () => {
  it("prefers `query` over other fields", () => {
    expect(
      toolCallSummary("web.search", {
        query: "nuclear submarines",
        name: "ignored",
      }),
    ).toBe("nuclear submarines");
  });

  it("honors the priority order (q before name)", () => {
    expect(toolCallSummary("x", { name: "second", q: "first" })).toBe("first");
  });

  it("falls through the priority list to the first present field", () => {
    expect(toolCallSummary("x", { path: "src/index.ts" })).toBe("src/index.ts");
    expect(toolCallSummary("x", { title: "Release notes" })).toBe(
      "Release notes",
    );
    expect(toolCallSummary("x", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });

  it("matches priority keys case-insensitively", () => {
    expect(toolCallSummary("x", { Query: "hello" })).toBe("hello");
    expect(toolCallSummary("x", { PROMPT: "write a poem" })).toBe(
      "write a poem",
    );
  });

  it("uses an id-ish field only as a last resort", () => {
    expect(toolCallSummary("x", { swarmId: "fan_abc123" })).toBe("fan_abc123");
    expect(toolCallSummary("x", { node_id: "n_42" })).toBe("n_42");
    expect(toolCallSummary("x", { id: "obj_1" })).toBe("obj_1");
    // A salient field wins over an id when both are present.
    expect(toolCallSummary("x", { id: "obj_1", name: "Widget" })).toBe(
      "Widget",
    );
  });

  it("does not treat plain words ending in 'id' as id fields", () => {
    expect(toolCallSummary("x", { valid: "yes", grid: "3x3" })).toBeNull();
  });

  it("collapses whitespace onto a single line", () => {
    expect(
      toolCallSummary("x", { prompt: "line one\n  line two\t\tmore" }),
    ).toBe("line one line two more");
  });

  it("truncates long values to a single clipped line with an ellipsis", () => {
    const long = "a".repeat(120);
    const out = toolCallSummary("x", { query: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(64);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("accepts a bare non-JSON string input", () => {
    expect(toolCallSummary("x", "just a string")).toBe("just a string");
  });

  it("returns null for an unparsed partial-JSON string (streaming args)", () => {
    expect(toolCallSummary("x", '{"query":')).toBeNull();
    expect(toolCallSummary("x", "[1,2")).toBeNull();
  });

  it("returns null when nothing salient is present", () => {
    expect(toolCallSummary("x", { count: 5, enabled: true })).toBeNull();
    expect(toolCallSummary("x", {})).toBeNull();
    expect(toolCallSummary("x", undefined)).toBeNull();
    expect(toolCallSummary("x", null)).toBeNull();
    expect(toolCallSummary("x", [1, 2, 3])).toBeNull();
  });

  it("ignores non-string salient values", () => {
    // `query` present but not a string → skip to the next candidate.
    expect(toolCallSummary("x", { query: 42, name: "fallback" })).toBe(
      "fallback",
    );
  });
});
