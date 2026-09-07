/**
 * The repro tables from #1357 and #1358. Both defects are the same mistake —
 * an unnormalized path used as identity — and in both a miss is a free pass
 * rather than a refusal, so the assertions that matter are the ones proving two
 * spellings land on ONE key.
 */
import { describe, expect, it } from "vitest";
import { canonicalPathKey, canonicalRelativePathKey } from "./path-identity";

describe("canonicalPathKey", () => {
  // #1357's executed repro: only the last two lines used to agree.
  it.each([
    ["src/foo.ts", "the plain relative spelling"],
    ["./src/foo.ts", "a leading dot"],
    ["src/../src/foo.ts", "a round trip through the parent"],
    ["src//foo.ts", "a duplicate separator"],
    ["./src/./foo.ts", "an interior dot"],
    ["/repo/src/foo.ts", "the absolute spelling"],
    ["/repo//src/foo.ts", "absolute with a duplicate separator"],
    ["/repo/src/../src/foo.ts", "absolute through the parent"],
  ])("%s resolves to one key (%s)", (spelling) => {
    expect(canonicalPathKey("/repo", spelling)).toBe("/repo/src/foo.ts");
  });

  it("keeps genuinely different files apart", () => {
    expect(canonicalPathKey("/repo", "src/foo.ts")).not.toBe(
      canonicalPathKey("/repo", "src/bar.ts"),
    );
    expect(canonicalPathKey("/repo", "a/foo.ts")).not.toBe(
      canonicalPathKey("/repo", "b/foo.ts"),
    );
  });

  it("does not fold case, because Linux does not", () => {
    expect(canonicalPathKey("/repo", "src/Foo.ts")).not.toBe(
      canonicalPathKey("/repo", "src/foo.ts"),
    );
  });

  it("tolerates a root with a trailing separator", () => {
    expect(canonicalPathKey("/repo/", "src/foo.ts")).toBe("/repo/src/foo.ts");
    expect(canonicalPathKey("/repo//", "./src/foo.ts")).toBe(
      "/repo/src/foo.ts",
    );
  });

  it("handles an empty root", () => {
    expect(canonicalPathKey("", "src/foo.ts")).toBe("/src/foo.ts");
    expect(canonicalPathKey("/", "src/foo.ts")).toBe("/src/foo.ts");
  });

  it("resolves a parent that climbs above the root", () => {
    expect(canonicalPathKey("/repo", "../other/foo.ts")).toBe("/other/foo.ts");
  });

  it("normalizes a Windows spelling onto one key", () => {
    expect(canonicalPathKey("C:/repo", "src\\foo.ts")).toBe(
      "C:/repo/src/foo.ts",
    );
    expect(canonicalPathKey("C:/repo", "C:\\repo\\src\\foo.ts")).toBe(
      "C:/repo/src/foo.ts",
    );
  });
});

describe("canonicalRelativePathKey", () => {
  // #1358's repro: three lease keys for one file on disk.
  it.each([
    "src/foo.ts",
    "./src/foo.ts",
    "src/../src/foo.ts",
    "src//foo.ts",
    "/src/foo.ts",
  ])("%s is one lock key", (spelling) => {
    expect(canonicalRelativePathKey(spelling)).toBe("src/foo.ts");
  });

  it("still separates two different files", () => {
    expect(canonicalRelativePathKey("src/a.ts")).not.toBe(
      canonicalRelativePathKey("src/b.ts"),
    );
  });
});
