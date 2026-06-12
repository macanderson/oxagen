import { describe, expect, it } from "vitest";
import { formatError } from "./lib/format-error";

describe("formatError", () => {
  it("returns the message for a plain Error", () => {
    const err = new Error("something went wrong");
    expect(formatError(err)).toBe("something went wrong");
  });

  it("appends the cause message when Error has a cause", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const err = new Error("Failed query: insert into users ...", { cause });
    expect(formatError(err)).toBe(
      "Failed query: insert into users ... — caused by: connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("walks nested causes up to the chain depth", () => {
    const root = new Error("root cause");
    const mid = new Error("middle", { cause: root });
    const top = new Error("top level", { cause: mid });
    expect(formatError(top)).toBe(
      "top level — caused by: middle — caused by: root cause",
    );
  });

  it("caps the cause chain at 5 levels to prevent unbounded output", () => {
    // Build a chain of 7 errors; only the first 5 causes should appear (6 total parts).
    let err: Error = new Error("level-6");
    for (let i = 5; i >= 0; i--) {
      err = new Error(`level-${i}`, { cause: err });
    }
    const result = formatError(err);
    // 6 parts = original + 5 cause levels
    const parts = result.split(" — caused by: ");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("level-0");
    expect(parts[5]).toBe("level-5");
  });

  it("handles a non-Error cause (plain string) in the chain", () => {
    const err = new Error("outer", { cause: "inner string cause" });
    expect(formatError(err)).toBe("outer — caused by: inner string cause");
  });

  it("returns String(value) for a non-Error thrown value", () => {
    expect(formatError("oops")).toBe("oops");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
    expect(formatError(undefined)).toBe("undefined");
    expect(formatError({ code: "ERR" })).toBe("[object Object]");
  });

  it("returns just the message when cause is undefined", () => {
    const err = new Error("no cause here");
    expect(formatError(err)).toBe("no cause here");
  });
});
