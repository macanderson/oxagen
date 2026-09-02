import { describe, it, expect } from "vitest";
import { emptyUsage, mergeUsage } from "./types";
import type { Workspace, CodingEvent } from "./types";

describe("types", () => {
  it("CodingEvent union includes final-diff", () => {
    const e: CodingEvent = { type: "final-diff", diff: "", changedFiles: [] };
    expect(e.type).toBe("final-diff");
  });
  it("Workspace shape is structurally usable", () => {
    const w: Pick<Workspace, "root"> = { root: "/tmp/repo" };
    expect(w.root).toBe("/tmp/repo");
  });
});

describe("emptyUsage", () => {
  it("is a fresh zeroed total each call (no shared reference)", () => {
    const a = emptyUsage();
    const b = emptyUsage();
    expect(a).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(a).not.toBe(b);
  });
});

describe("mergeUsage", () => {
  it("adds every field additively", () => {
    const merged = mergeUsage(
      { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
      { inputTokens: 3, outputTokens: 7, costUsd: 0.25 },
    );
    expect(merged).toEqual({
      inputTokens: 13,
      outputTokens: 12,
      costUsd: 0.35,
    });
  });

  it("does not mutate its operands", () => {
    const a = emptyUsage();
    const b = { inputTokens: 1, outputTokens: 2, costUsd: 3 };
    mergeUsage(a, b);
    expect(a).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(b).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 3 });
  });
});
