import { describe, expect, it } from "vitest";
import { codeDiff } from "./code.diff";
import { getCapability } from "../registry";

describe("code.diff capability", () => {
  it("accepts a minimal valid input", () => {
    const parsed = codeDiff.input.parse({ before: "a\n", after: "b\n" });
    expect(parsed.before).toBe("a\n");
    expect(parsed.after).toBe("b\n");
  });

  it("defaults path to 'file'", () => {
    const parsed = codeDiff.input.parse({ before: "a", after: "b" });
    expect(parsed.path).toBe("file");
  });

  it("defaults contextLines to 3", () => {
    const parsed = codeDiff.input.parse({ before: "a", after: "b" });
    expect(parsed.contextLines).toBe(3);
  });

  it("accepts an explicit path and contextLines", () => {
    const parsed = codeDiff.input.parse({
      before: "a",
      after: "b",
      path: "src/x.ts",
      contextLines: 0,
    });
    expect(parsed.path).toBe("src/x.ts");
    expect(parsed.contextLines).toBe(0);
  });

  it("rejects a contextLines above the max", () => {
    expect(() =>
      codeDiff.input.parse({ before: "a", after: "b", contextLines: 101 }),
    ).toThrow();
  });

  it("rejects a non-integer contextLines", () => {
    expect(() =>
      codeDiff.input.parse({ before: "a", after: "b", contextLines: 1.5 }),
    ).toThrow();
  });

  it("rejects an over-large blob", () => {
    const huge = "x".repeat(1024 * 1024 + 1);
    expect(() => codeDiff.input.parse({ before: huge, after: "b" })).toThrow();
  });

  it("rejects an empty path", () => {
    expect(() =>
      codeDiff.input.parse({ before: "a", after: "b", path: "" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = codeDiff.output.parse({
      diff: "--- a\n+++ b\n",
      changed: true,
      additions: 1,
      deletions: 0,
    });
    expect(parsed.changed).toBe(true);
    expect(parsed.additions).toBe(1);
  });

  it("rejects output with a non-integer additions count", () => {
    expect(() =>
      codeDiff.output.parse({
        diff: "",
        changed: false,
        additions: 1.2,
        deletions: 0,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("code.diff")).toBe(codeDiff);
  });

  it("declares the api, mcp, and agent surfaces", () => {
    expect(codeDiff.surfaces).toEqual(["api", "mcp", "agent"]);
  });
});
