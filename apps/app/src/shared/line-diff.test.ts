import { describe, expect, it } from "vitest";
import { diffStat } from "./line-diff";

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
