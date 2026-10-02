// The Context PR page's line diff (#5077): an added file is every line added,
// a removed one every line removed, an edit keeps what both sides share, and
// a pair too large for the exact table falls back to removed then added.
import { describe, expect, it } from "vitest";
import { LINE_DIFF_MAX_CELLS, lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("draws an added file as every line added, numbered on the head", () => {
    expect(lineDiff(null, "a\nb\n")).toEqual([
      { kind: "added", text: "a", before: null, after: 1 },
      { kind: "added", text: "b", before: null, after: 2 },
    ]);
  });

  it("draws a removed file as every line removed, numbered on the base", () => {
    expect(lineDiff("a\nb", null)).toEqual([
      { kind: "removed", text: "a", before: 1, after: null },
      { kind: "removed", text: "b", before: 2, after: null },
    ]);
  });

  it("keeps the lines both sides share and marks the edit between them", () => {
    expect(
      lineDiff('id = "x"\nstatement = "old"\nforce = "must"\n', 'id = "x"\nstatement = "new"\nforce = "must"\n').map(
        (line) => [line.kind, line.text, line.before, line.after],
      ),
    ).toEqual([
      ["same", 'id = "x"', 1, 1],
      ["removed", 'statement = "old"', 2, null],
      ["added", 'statement = "new"', null, 2],
      ["same", 'force = "must"', 3, 3],
    ]);
  });

  it("reads CRLF line ends as line ends", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb\n").every((l) => l.kind === "same")).toBe(
      true,
    );
  });

  it("answers nothing for two empty sides (negative)", () => {
    expect(lineDiff("", null)).toEqual([]);
  });

  it("falls back to removed then added past the cell cap (negative)", () => {
    const side = Math.ceil(Math.sqrt(LINE_DIFF_MAX_CELLS)) + 1;
    const before = Array.from({ length: side }, (_, i) => `a${String(i)}`).join("\n");
    const after = Array.from({ length: side }, (_, i) => `a${String(i)}`).join("\n");
    const out = lineDiff(before, after);
    expect(out).toHaveLength(side * 2);
    expect(out[0]?.kind).toBe("removed");
    expect(out.at(-1)?.kind).toBe("added");
  });
});
