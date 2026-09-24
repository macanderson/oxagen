// The source editor's key edits and find count (source-keys.ts), read without
// a DOM: Tab and ⇧Tab over a caret, over one line and over a block, ⌘/ both
// ways round, and the find offsets and the status line's line and column.
import { describe, expect, it } from "vitest";
import {
  findAll,
  indent,
  lineCol,
  outdent,
  toggleComment,
} from "./source-keys";

describe("indent", () => {
  it("puts two spaces at a caret and moves the caret past them", () => {
    expect(indent("ab", 1, 1)).toEqual({ value: "a  b", start: 3, end: 3 });
  });

  it("indents every line a selection spans, from the start of its first line", () => {
    const value = "one\ntwo\nthree";
    // From inside "one" to inside "two".
    expect(indent(value, 1, 5)).toEqual({
      value: "  one\n  two\nthree",
      start: 3,
      end: 9,
    });
  });

  it("does not indent the line after a selection that ends on its newline", () => {
    const value = "one\ntwo\nthree";
    // "one\n" selected whole: the caret sits at the start of "two".
    expect(indent(value, 0, 4).value).toBe("  one\ntwo\nthree");
  });

  it("indents a selection on a later line from that line's start", () => {
    expect(indent("one\ntwo", 5, 6).value).toBe("one\n  two");
  });
});

describe("outdent", () => {
  it("takes two spaces, one space or nothing off each line", () => {
    const value = "  two\n one\nnone";
    expect(outdent(value, 0, value.length)).toEqual({
      value: "two\none\nnone",
      start: 0,
      end: value.length - 3,
    });
  });

  it("keeps the caret inside its line when the cut is wider than the caret offset", () => {
    // Caret at column 1 of "  x": two spaces go, the caret stops at the line start.
    expect(outdent("a\n  x", 3, 3)).toEqual({
      value: "a\nx",
      start: 2,
      end: 2,
    });
  });

  it("leaves a line with no leading space as it is (negative)", () => {
    expect(outdent("abc", 1, 1)).toEqual({ value: "abc", start: 1, end: 1 });
  });
});

describe("toggleComment", () => {
  it("comments every non-blank line and keeps the indent before the mark", () => {
    const value = "a = 1\n\n  b = 2";
    expect(toggleComment(value, 0, value.length)).toEqual({
      value: "# a = 1\n\n  # b = 2",
      start: 0,
      end: 18,
    });
  });

  it("uncomments when every non-blank line already is, with or without the space", () => {
    const value = "# a = 1\n\n  #b = 2";
    expect(toggleComment(value, 0, value.length).value).toBe(
      "a = 1\n\n  b = 2",
    );
  });

  it("comments a mixed block rather than uncommenting half of it (negative)", () => {
    expect(toggleComment("# a\nb", 0, 5).value).toBe("# # a\n# b");
  });
});

describe("findAll", () => {
  it("finds every case-insensitive match, without overlaps", () => {
    expect(findAll("Tool tool TOOLtool", "tool")).toEqual([0, 5, 10, 14]);
    expect(findAll("aaaa", "aa")).toEqual([0, 2]);
  });

  it("finds nothing for an empty query or an absent one (negative)", () => {
    expect(findAll("anything", "")).toEqual([]);
    expect(findAll("anything", "zzz")).toEqual([]);
  });
});

describe("lineCol", () => {
  it("counts lines and columns from one", () => {
    expect(lineCol("", 0)).toEqual({ line: 1, col: 1 });
    expect(lineCol("ab\ncd", 4)).toEqual({ line: 2, col: 2 });
    expect(lineCol("ab\n", 3)).toEqual({ line: 2, col: 1 });
  });
});
