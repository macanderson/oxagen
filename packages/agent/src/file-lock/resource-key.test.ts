/**
 * #1358's repro. The lock's whole job is mutual exclusion, and its key IS its
 * notion of "the same file" — so two spellings of one path becoming two lease
 * keys means both agents are granted, both write, and the last writer wins
 * silently.
 *
 * The old implementation stripped one leading separator and returned the rest
 * verbatim, under a local variable named `normalizedPath`.
 */
import { describe, expect, it } from "vitest";
import { toFileResourceKey } from "./resource-key";

const OWNER = "macanderson";
const REPO = "oxagen";

describe("toFileResourceKey", () => {
  it.each([
    ["src/foo.ts", "the plain spelling"],
    ["./src/foo.ts", "a leading dot"],
    ["src/../src/foo.ts", "a round trip through the parent"],
    ["src//foo.ts", "a duplicate separator"],
    ["/src/foo.ts", "a leading separator"],
    ["./src/./foo.ts", "an interior dot"],
  ])("%s is one lease key with repo coordinates (%s)", (spelling) => {
    expect(toFileResourceKey(spelling, OWNER, REPO)).toBe(
      "github:macanderson/oxagen:src/foo.ts",
    );
  });

  it.each([
    "src/foo.ts",
    "./src/foo.ts",
    "src/../src/foo.ts",
    "src//foo.ts",
    "/src/foo.ts",
  ])("%s is one lease key without repo coordinates", (spelling) => {
    // This is the branch that used to return the path completely untouched.
    expect(toFileResourceKey(spelling, undefined, undefined)).toBe(
      "src/foo.ts",
    );
  });

  it("still separates two different files", () => {
    expect(toFileResourceKey("src/a.ts", OWNER, REPO)).not.toBe(
      toFileResourceKey("src/b.ts", OWNER, REPO),
    );
  });

  it("still separates the same path in two repositories", () => {
    expect(toFileResourceKey("src/foo.ts", OWNER, "oxagen")).not.toBe(
      toFileResourceKey("src/foo.ts", OWNER, "stella"),
    );
  });

  it("keeps an uncoordinated key distinct from a repository-scoped one", () => {
    expect(toFileResourceKey("src/foo.ts", undefined, undefined)).not.toBe(
      toFileResourceKey("src/foo.ts", OWNER, REPO),
    );
  });
});
