// compare.ts: the first place two JSON values differ, and how a message
// shows it.
import { describe, expect, it } from "vitest";
import { describePath, describeValue, firstDifference } from "./compare";

describe("firstDifference", () => {
  it("finds none when the values match, whatever the key order", () => {
    expect(firstDifference({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBeUndefined();
  });

  it("counts a key set to undefined as absent", () => {
    expect(firstDifference({ a: 1 }, { a: 1, b: undefined })).toBeUndefined();
  });

  it("names the first nested value that differs", () => {
    expect(firstDifference({ data: [{ id: "ch_1", amount: 4000 }] }, { data: [{ id: "ch_1", amount: 5000 }] })).toEqual({
      path: "data[0].amount",
      expected: 4000,
      actual: 5000,
    });
  });

  it("names a key the replay lost", () => {
    expect(firstDifference({ a: 1, b: 2 }, { a: 1 })).toEqual({ path: "b", expected: 2, actual: undefined });
  });

  it("names a key the replay added", () => {
    expect(firstDifference({ a: 1 }, { a: 1, b: 2 })).toEqual({ path: "b", expected: undefined, actual: 2 });
  });

  it("names the first item past the shorter list", () => {
    expect(firstDifference([1, 2], [1])).toEqual({ path: "[1]", expected: 2, actual: undefined });
    expect(firstDifference({ list: [1] }, { list: [1, 2] })).toEqual({ path: "list[1]", expected: undefined, actual: 2 });
  });

  it("quotes a key that is not a plain name", () => {
    expect(firstDifference({ headers: { "x.y": "1" } }, { headers: { "x.y": "2" } })).toEqual({
      path: 'headers["x.y"]',
      expected: "1",
      actual: "2",
    });
    expect(firstDifference({ "a b": 1 }, { "a b": 2 })?.path).toBe('["a b"]');
  });

  it("compares values of different types at the top", () => {
    expect(firstDifference("text", { text: true })).toEqual({ path: "", expected: "text", actual: { text: true } });
  });
});

describe("describeValue", () => {
  it("writes nothing for an absent value", () => {
    expect(describeValue(undefined)).toBe("nothing");
  });

  it("writes JSON, cut at 120 characters", () => {
    expect(describeValue({ id: "ch_1" })).toBe('{"id":"ch_1"}');
    const long = "x".repeat(200);
    expect(describeValue(long)).toBe(`${JSON.stringify(long).slice(0, 120)}...`);
  });
});

describe("describePath", () => {
  it("names the top level when the path is empty", () => {
    expect(describePath("")).toBe("at the top level");
    expect(describePath("body.amount")).toBe("at body.amount");
  });
});
