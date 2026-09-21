import { describe, expect, it } from "vitest";
import { buildDiff, DIFF_CONTEXT, diffLines, diffStat } from "./line-diff";

describe("diffStat", () => {
  it("counts nothing for an unchanged draft", () => {
    expect(diffStat("a\nb\nc", "a\nb\nc")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a changed line as one removed and one added", () => {
    expect(diffStat("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
  });

  it("counts inserted and deleted lines around the lines both keep", () => {
    expect(diffStat("a\nb\nc\nd", "x\na\nc\nd\ny\nz")).toEqual({
      added: 3,
      removed: 1,
    });
  });

  it("counts every line of an emptied file as removed", () => {
    expect(diffStat("a\nb", "")).toEqual({ added: 1, removed: 2 });
  });
});

describe("diffLines", () => {
  it("marks every line of an unchanged text as context", () => {
    const out = diffLines("a\nb", "a\nb");
    expect(out.map((line) => line.op)).toEqual(["ctx", "ctx"]);
    expect(out[0]).toEqual({ op: "ctx", text: "a", before: 1, after: 1 });
  });

  it("numbers each side against its own text", () => {
    const out = diffLines("a\nb\nc", "a\nc");
    expect(out).toEqual([
      { op: "ctx", text: "a", before: 1, after: 1 },
      { op: "del", text: "b", before: 2, after: null },
      { op: "ctx", text: "c", before: 3, after: 2 },
    ]);
  });

  it("reads a replacement as the deletion first, then the addition", () => {
    const out = diffLines("old", "new");
    expect(out.map((line) => line.op)).toEqual(["del", "add"]);
  });

  it("treats an empty side as pure addition or pure deletion", () => {
    expect(diffLines("", "a\nb").every((line) => line.op === "add")).toBe(true);
    expect(diffLines("a\nb", "").every((line) => line.op === "del")).toBe(true);
    expect(diffLines("", "")).toEqual([]);
  });

  it("keeps every line of both texts", () => {
    const before = "a\nb\nc\nd";
    const after = "a\nx\nc\ny\nz";
    const out = diffLines(before, after);
    const kept = (op: "del" | "add") =>
      out.filter((line) => line.op === op || line.op === "ctx").length;
    expect(kept("del")).toBe(before.split("\n").length);
    expect(kept("add")).toBe(after.split("\n").length);
  });
});

describe("buildDiff", () => {
  it("counts what was added and removed", () => {
    const diff = buildDiff("a\nb\nc", "a\nB\nc\nd");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.wholesale).toBe(false);
  });

  it("drops the unchanged middle of a large file and splits the hunks", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`);
    const before = ["head", ...filler, "tail"].join("\n");
    const after = ["HEAD", ...filler, "TAIL"].join("\n");
    const diff = buildDiff(before, after);
    expect(diff.hunks).toHaveLength(2);
    // Three lines of context either side of each change, and nothing between.
    expect(diff.hunks[0]?.lines).toHaveLength(2 + DIFF_CONTEXT);
    expect(diff.hunks[1]?.lines).toHaveLength(2 + DIFF_CONTEXT);
  });

  it("starts each hunk at the first line that carries that side's number", () => {
    // The change opens the file, so the hunk's first line is a deletion with
    // no `after` and the second is an addition with no `before`.
    const diff = buildDiff("a\nb\nc", "z\nb\nc");
    const hunk = diff.hunks[0];
    expect(hunk?.beforeStart).toBe(1);
    expect(hunk?.afterStart).toBe(1);
  });

  it("holds a one-line file in a single hunk", () => {
    const diff = buildDiff("before", "after");
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines.map((line) => line.op)).toEqual(["del", "add"]);
  });

  it("returns no hunks when nothing changed", () => {
    const diff = buildDiff("a\nb", "a\nb");
    expect(diff.hunks).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it("falls back to a wholesale replacement rather than build a huge table", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${String(i)}`).join("\n");
    const diff = buildDiff(big, `${big}\nmore`);
    expect(diff.wholesale).toBe(true);
    expect(diff.removed).toBe(2000);
    expect(diff.added).toBe(2001);
  });
});
