/**
 * Additional tests for sync/pn-counter.ts — toJSON and fromJSON.
 * The core increment/decrement/merge/value tests live in sync.test.ts.
 */
import { describe, it, expect } from "vitest";
import { PNCounter } from "./pn-counter";

describe("PNCounter.toJSON", () => {
  it("serializes empty counter", () => {
    const counter = new PNCounter();
    const json = counter.toJSON();
    expect(json).toEqual({ positive: {}, negative: {} });
  });

  it("serializes increments", () => {
    const counter = new PNCounter();
    counter.increment("node-a", 3);
    counter.increment("node-b", 1);
    const json = counter.toJSON();
    expect(json.positive).toEqual({ "node-a": 3, "node-b": 1 });
    expect(json.negative).toEqual({});
  });

  it("serializes both increments and decrements", () => {
    const counter = new PNCounter();
    counter.increment("node-a", 5);
    counter.decrement("node-b", 2);
    const json = counter.toJSON();
    expect(json.positive).toEqual({ "node-a": 5 });
    expect(json.negative).toEqual({ "node-b": 2 });
  });

  it("produces plain objects (not Maps)", () => {
    const counter = new PNCounter();
    counter.increment("x", 1);
    const json = counter.toJSON();
    expect(typeof json.positive).toBe("object");
    expect(Array.isArray(json.positive)).toBe(false);
    expect(json.positive instanceof Map).toBe(false);
  });
});

describe("PNCounter.fromJSON", () => {
  it("restores empty counter from JSON", () => {
    const counter = PNCounter.fromJSON({ positive: {}, negative: {} });
    expect(counter.value()).toBe(0);
  });

  it("restores correct value from JSON", () => {
    const counter = PNCounter.fromJSON({
      positive: { "node-a": 10, "node-b": 5 },
      negative: { "node-a": 3 },
    });
    // 10 + 5 - 3 = 12
    expect(counter.value()).toBe(12);
  });

  it("round-trips through toJSON/fromJSON", () => {
    const original = new PNCounter();
    original.increment("node-a", 7);
    original.increment("node-b", 3);
    original.decrement("node-a", 2);

    const restored = PNCounter.fromJSON(original.toJSON());
    expect(restored.value()).toBe(original.value());
  });

  it("restored counter can be further incremented", () => {
    const original = new PNCounter();
    original.increment("node-a", 5);

    const restored = PNCounter.fromJSON(original.toJSON());
    restored.increment("node-b", 2);
    expect(restored.value()).toBe(7);
  });

  it("restored counter can be merged", () => {
    const a = new PNCounter();
    a.increment("node-a", 3);

    const b = new PNCounter();
    b.increment("node-b", 4);

    const restoredA = PNCounter.fromJSON(a.toJSON());
    const merged = restoredA.merge(b);
    expect(merged.value()).toBe(7);
  });
});
