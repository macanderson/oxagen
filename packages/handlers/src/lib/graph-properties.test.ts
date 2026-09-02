/**
 * graph-properties tests — safeParseProperties must NEVER throw.
 *
 * The graph.node.get / graph.node.list handlers previously JSON.parse'd the
 * `properties` column unguarded, so one corrupt blob 500'd the whole graph
 * explorer. Verify every drift shape degrades to a usable Record instead:
 * null/undefined → {}, malformed JSON → {} (+ warning), JSON scalars/arrays →
 * {}, native driver maps pass through, and Neo4j Integer-like {low, high}
 * values are normalised to plain numbers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import { safeParseProperties } from "./graph-properties";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("safeParseProperties", () => {
  it("returns {} for null and undefined without warning", () => {
    expect(safeParseProperties(null)).toEqual({});
    expect(safeParseProperties(undefined)).toEqual({});
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("parses a valid JSON object string", () => {
    expect(safeParseProperties('{"status":"open","count":3}')).toEqual({
      status: "open",
      count: 3,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("returns {} and warns with the node id on malformed JSON", () => {
    expect(safeParseProperties("{not json", { nodeId: "n-1" })).toEqual({});
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "n-1" }),
      expect.stringContaining("malformed JSON"),
    );
  });

  it("returns {} for valid JSON that is not a plain object", () => {
    expect(safeParseProperties('"just a string"')).toEqual({});
    expect(safeParseProperties("42")).toEqual({});
    expect(safeParseProperties("[1,2,3]")).toEqual({});
    expect(safeParseProperties("null")).toEqual({});
    expect(mocks.warn).toHaveBeenCalledTimes(4);
  });

  it("passes a native driver map object through unchanged", () => {
    const bag = { status: "open", nested: { deep: true } };
    expect(safeParseProperties(bag)).toBe(bag);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("returns {} for a non-string, non-plain-object value (array, number)", () => {
    expect(safeParseProperties([1, 2])).toEqual({});
    expect(safeParseProperties(7)).toEqual({});
    expect(mocks.warn).toHaveBeenCalledTimes(2);
  });

  it("normalises Neo4j Integer-like {low, high} values to plain numbers", () => {
    expect(
      safeParseProperties({ count: { low: 7, high: 0 }, name: "x" }),
    ).toEqual({ count: 7, name: "x" });
  });

  it("recombines both halves of a driver Integer larger than 32 bits", () => {
    // 2^32 is {low: 0, high: 1}; reading `low` alone would report 0.
    expect(safeParseProperties({ bytes: { low: 0, high: 1 } })).toEqual({
      bytes: 4294967296,
    });
    // Negative values are two's-complement across both halves: -1 is {-1, -1}.
    expect(safeParseProperties({ delta: { low: -1, high: -1 } })).toEqual({
      delta: -1,
    });
  });

  it("leaves objects that merely resemble driver integers untouched", () => {
    // Extra keys or non-number members mean it is user data, not a driver int.
    const range = { low: 1, high: 10, unit: "ms" };
    expect(safeParseProperties({ range })).toEqual({ range });
    const strings = { low: "a", high: "b" };
    expect(safeParseProperties({ strings })).toEqual({ strings });
  });
});
