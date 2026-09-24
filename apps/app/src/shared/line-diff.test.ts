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
    const big = Array.from(
      { length: 2000 },
      (_, i) => `line ${String(i)}`,
    ).join("\n");
    const diff = buildDiff(big, `${big}\nmore`);
    expect(diff.wholesale).toBe(true);
    expect(diff.removed).toBe(2000);
    expect(diff.added).toBe(2001);
  });
});

describe("diffStat, edges", () => {
  it("counts a pure insertion into the middle as additions only", () => {
    expect(diffStat("a\nd", "a\nb\nc\nd")).toEqual({ added: 2, removed: 0 });
  });

  it("counts two empty texts as unchanged", () => {
    expect(diffStat("", "")).toEqual({ added: 0, removed: 0 });
  });

  // Characterization: diffStat splits "" into one empty line, while buildDiff
  // reads "" as no lines at all. So a first line typed into an empty file is
  // counted as the empty line removed and the new line added. Pinned so a
  // change to it is a decision, not an accident.
  it("counts an empty base as one empty line, unlike buildDiff", () => {
    expect(diffStat("", "a")).toEqual({ added: 1, removed: 1 });
    expect(buildDiff("", "a")).toMatchObject({ added: 1, removed: 0 });
  });

  it("counts a trailing newline as one added empty line", () => {
    expect(diffStat("a", "a\n")).toEqual({ added: 1, removed: 0 });
  });

  it("agrees with buildDiff on every non-empty pair", () => {
    const pairs: Array<[string, string]> = [
      ["a\nb\nc", "a\nB\nc\nd"],
      ["x\ny\nz", "z\ny\nx"],
      ["a\nb\nc\nd\ne", "a\nc\ne"],
      ["same", "same"],
    ];
    for (const [before, after] of pairs) {
      const { added, removed } = buildDiff(before, after);
      expect(diffStat(before, after)).toEqual({ added, removed });
    }
  });
});

describe("diffLines, edges", () => {
  it("reads an insertion ahead of a kept line as an addition, not a replacement", () => {
    expect(diffLines("a", "x\na")).toEqual([
      { op: "add", text: "x", before: null, after: 1 },
      { op: "ctx", text: "a", before: 1, after: 2 },
    ]);
  });

  it("drains the old text's tail as deletions once the new text runs out", () => {
    expect(diffLines("a\nb\nc", "a")).toEqual([
      { op: "ctx", text: "a", before: 1, after: 1 },
      { op: "del", text: "b", before: 2, after: null },
      { op: "del", text: "c", before: 3, after: null },
    ]);
  });

  it("drains the new text's tail as additions once the old text runs out", () => {
    expect(diffLines("a", "a\nb\nc")).toEqual([
      { op: "ctx", text: "a", before: 1, after: 1 },
      { op: "add", text: "b", before: null, after: 2 },
      { op: "add", text: "c", before: null, after: 3 },
    ]);
  });

  it("keeps the longest common run when lines move", () => {
    // "b\nc" survives; "a" moves from the top to the bottom.
    expect(diffLines("a\nb\nc", "b\nc\na")).toEqual([
      { op: "del", text: "a", before: 1, after: null },
      { op: "ctx", text: "b", before: 2, after: 1 },
      { op: "ctx", text: "c", before: 3, after: 2 },
      { op: "add", text: "a", before: null, after: 3 },
    ]);
  });

  it("numbers every line of an empty-sided diff from 1", () => {
    expect(diffLines("", "p\nq")).toEqual([
      { op: "add", text: "p", before: null, after: 1 },
      { op: "add", text: "q", before: null, after: 2 },
    ]);
    expect(diffLines("p\nq", "")).toEqual([
      { op: "del", text: "p", before: 1, after: null },
      { op: "del", text: "q", before: 2, after: null },
    ]);
  });
});

describe("buildDiff, hunks", () => {
  const numbered = (count: number, prefix = "l") =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1)}`);

  it("starts a mid-file hunk DIFF_CONTEXT lines above the change on both sides", () => {
    const before = numbered(20);
    const after = [...before];
    after[9] = "changed";
    const diff = buildDiff(before.join("\n"), after.join("\n"));
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0];
    expect(hunk?.beforeStart).toBe(10 - DIFF_CONTEXT);
    expect(hunk?.afterStart).toBe(10 - DIFF_CONTEXT);
    expect(hunk?.lines.map((line) => line.op)).toEqual([
      "ctx",
      "ctx",
      "ctx",
      "del",
      "add",
      "ctx",
      "ctx",
      "ctx",
    ]);
    expect(hunk?.lines[0]?.text).toBe("l7");
    expect(hunk?.lines.at(-1)?.text).toBe("l13");
  });

  it("offsets the new side's start by the lines an earlier hunk added", () => {
    const before = numbered(30);
    const after = ["new1", "new2", ...before];
    after[25 + 2] = "changed"; // old line 26
    const diff = buildDiff(before.join("\n"), after.join("\n"));
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]).toMatchObject({ beforeStart: 1, afterStart: 1 });
    expect(diff.hunks[1]).toMatchObject({
      beforeStart: 26 - DIFF_CONTEXT,
      afterStart: 28 - DIFF_CONTEXT,
    });
  });

  it("clips context at the end of the file", () => {
    const before = numbered(5);
    const after = [...before.slice(0, 4), "last"];
    const diff = buildDiff(before.join("\n"), after.join("\n"));
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines.map((line) => line.text)).toEqual([
      "l2",
      "l3",
      "l4",
      "l5",
      "last",
    ]);
  });

  it("joins two changes separated by exactly twice the context into one hunk", () => {
    const before = numbered(2 * DIFF_CONTEXT + 2);
    const after = [...before];
    after[0] = "first";
    after[after.length - 1] = "last";
    const diff = buildDiff(before.join("\n"), after.join("\n"));
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]?.lines).toHaveLength(4 + 2 * DIFF_CONTEXT);
  });

  it("splits two changes separated by one line more than twice the context", () => {
    const before = numbered(2 * DIFF_CONTEXT + 3);
    const after = [...before];
    after[0] = "first";
    after[after.length - 1] = "last";
    const diff = buildDiff(before.join("\n"), after.join("\n"));
    expect(diff.hunks).toHaveLength(2);
    // The one line between the two contexts is dropped.
    const shown = diff.hunks.flatMap((hunk) => hunk.lines.map((l) => l.text));
    expect(shown).not.toContain(`l${String(DIFF_CONTEXT + 2)}`);
    expect(diff.hunks[1]).toMatchObject({
      beforeStart: DIFF_CONTEXT + 3,
      afterStart: DIFF_CONTEXT + 3,
    });
  });

  // Characterization: a hunk with no old lines (a file written from nothing)
  // starts its old side at 1, where `diff -u` would print 0. Likewise a hunk
  // with no new lines starts its new side at 1.
  it("starts the empty side of a pure addition or pure deletion at 1", () => {
    const added = buildDiff("", "a\nb");
    expect(added).toMatchObject({ added: 2, removed: 0, wholesale: false });
    expect(added.hunks).toHaveLength(1);
    expect(added.hunks[0]).toMatchObject({ beforeStart: 1, afterStart: 1 });
    expect(added.hunks[0]?.lines.every((l) => l.before === null)).toBe(true);

    const removed = buildDiff("a\nb", "");
    expect(removed).toMatchObject({ added: 0, removed: 2 });
    expect(removed.hunks[0]).toMatchObject({ beforeStart: 1, afterStart: 1 });
    expect(removed.hunks[0]?.lines.every((l) => l.after === null)).toBe(true);
  });

  it("returns nothing for two empty texts", () => {
    expect(buildDiff("", "")).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
      wholesale: false,
    });
  });
});

describe("buildDiff, wholesale", () => {
  const numbered = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`).join("\n");

  it("compares line by line at exactly the cell ceiling", () => {
    // (1999 + 1) x (999 + 1) = 2,000,000 cells: not above the ceiling.
    const before = numbered(1999, "b");
    const after = `${before.split("\n").slice(0, 998).join("\n")}\nextra`;
    const diff = buildDiff(before, after);
    expect(diff.wholesale).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1999 - 998);
  });

  it("replaces wholesale one cell above the ceiling", () => {
    // (1999 + 1) x (1000 + 1) cells.
    const before = numbered(1999, "b");
    const after = numbered(1000, "a");
    const diff = buildDiff(before, after);
    expect(diff.wholesale).toBe(true);
    expect(diff.removed).toBe(1999);
    expect(diff.added).toBe(1000);
  });

  it("draws a wholesale replacement as one hunk, every old line then every new one", () => {
    const before = numbered(1500, "b");
    const after = numbered(1500, "a");
    const diff = buildDiff(before, after);
    expect(diff.wholesale).toBe(true);
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0];
    expect(hunk).toMatchObject({ beforeStart: 1, afterStart: 1 });
    expect(hunk?.lines).toHaveLength(3000);
    expect(hunk?.lines[0]).toEqual({
      op: "del",
      text: "b0",
      before: 1,
      after: null,
    });
    expect(hunk?.lines[1499]).toEqual({
      op: "del",
      text: "b1499",
      before: 1500,
      after: null,
    });
    expect(hunk?.lines[1500]).toEqual({
      op: "add",
      text: "a0",
      before: null,
      after: 1,
    });
    expect(hunk?.lines.at(-1)).toEqual({
      op: "add",
      text: "a1499",
      before: null,
      after: 1500,
    });
  });

  // Characterization: above the ceiling nothing is compared, so two identical
  // large texts read as every line replaced. The `wholesale` flag is what
  // tells the surface to say so rather than present it as a measurement.
  it("reports identical texts above the ceiling as wholly replaced", () => {
    const text = numbered(1500, "x");
    const diff = buildDiff(text, text);
    expect(diff).toMatchObject({ wholesale: true, added: 1500, removed: 1500 });
  });
});
