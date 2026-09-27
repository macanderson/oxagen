// util.ts: the helpers the executor's modules share.
import { describe, expect, it } from "vitest";
import { BuildError, isList, isRecord, jsonEqual, messageOf, valueAt, withValueAt } from "./util";

describe("messageOf", () => {
  it("reads an error's message, and turns anything else into text", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
  });
});

describe("isRecord and isList", () => {
  it("tells objects from arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isList([])).toBe(true);
    expect(isList({})).toBe(false);
  });
});

describe("jsonEqual", () => {
  it("compares scalars, arrays, and objects by value", () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual(1, "1")).toBe(false);
    expect(jsonEqual([1, [2]], [1, [2]])).toBe(true);
    expect(jsonEqual([1, 2], [1])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, c: 3 }, { a: 1, b: 3 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, null)).toBe(false);
  });
});

describe("BuildError", () => {
  it("carries a title for the error result", () => {
    const error = new BuildError("Invalid arguments", "customer_id is missing");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BuildError");
    expect(error.title).toBe("Invalid arguments");
    expect(error.message).toBe("customer_id is missing");
  });
});

describe("valueAt", () => {
  const value = { pageInfo: { endCursor: "c2", hasNextPage: true }, data: [1] };

  it("reads a dotted path", () => {
    expect(valueAt(value, "pageInfo.endCursor")).toBe("c2");
    expect(valueAt(value, "data")).toEqual([1]);
  });

  it("reads nothing through a missing key, a non-object, or an array step", () => {
    expect(valueAt(value, "pageInfo.missing")).toBeUndefined();
    expect(valueAt(value, "data.length")).toBeUndefined();
    expect(valueAt(value, "data[].id")).toBeUndefined();
    expect(valueAt({}, "toString")).toBeUndefined();
  });
});

describe("withValueAt", () => {
  it("sets a nested path on a copy", () => {
    const value = { a: { b: 1, c: 2 }, d: 3 };
    const out = withValueAt(value, "a.b", 9);
    expect(out).toEqual({ a: { b: 9, c: 2 }, d: 3 });
    expect(value.a.b).toBe(1);
  });

  it("adds a missing top-level key", () => {
    expect(withValueAt({ a: 1 }, "b", 2)).toEqual({ a: 1, b: 2 });
  });

  it("leaves the value alone when the path passes through a non-object", () => {
    const value = { a: [1] };
    expect(withValueAt(value, "a.b", 2)).toBe(value);
    expect(withValueAt({ a: 1 }, "missing.b", 2)).toEqual({ a: 1 });
    expect(withValueAt("text", "a", 1)).toBe("text");
  });

  it("keeps __proto__ as an own data key", () => {
    const out = withValueAt({}, "__proto__", { polluted: true }) as Record<string, unknown>;
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
