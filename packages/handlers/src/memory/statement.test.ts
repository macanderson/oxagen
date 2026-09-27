import { describe, expect, it } from "vitest";
import {
  contradicts,
  jaccard,
  normalizeStatement,
  saysSame,
  statementHash,
  statementWords,
} from "./statement";

describe("normalizeStatement", () => {
  it("lowercases, drops apostrophes, turns punctuation to spaces, and collapses whitespace", () => {
    expect(normalizeStatement("  Don't run `pnpm i` in CI!\n\tUse the cache.  ")).toBe(
      "dont run pnpm i in ci use the cache",
    );
    expect(normalizeStatement("Don’t touch src/billing/**")).toBe(
      "dont touch src billing",
    );
  });

  it("keeps letters and digits from any script", () => {
    expect(normalizeStatement("Ünïcode — 42 ÉTÉ")).toBe("ünïcode 42 été");
  });
});

describe("statementHash", () => {
  it("is the sha256 of the normalized statement, in hex", () => {
    expect(statementHash("Run the tests.")).toBe(statementHash("run   THE tests"));
    expect(statementHash("Run the tests.")).toMatch(/^[0-9a-f]{64}$/);
    expect(statementHash("Run the tests.")).not.toBe(statementHash("Skip the tests."));
  });
});

describe("statementWords", () => {
  it("leaves out stopwords and stems a plural", () => {
    const read = statementWords("Always run the tests before a merge");
    expect([...read.words].sort()).toEqual(["merge", "run", "test"]);
    expect(read.negated).toBe(false);
  });

  it("reads each negation, and no longer as one", () => {
    for (const statement of [
      "Never push to main",
      "Do not push to main",
      "Avoid pushing to main",
      "Stop pushing to main",
      "Don't push to main",
      "We no longer push to main",
    ]) {
      const read = statementWords(statement);
      expect(read.negated).toBe(true);
      expect(read.words.has("main")).toBe(true);
      expect(read.words.has("longer")).toBe(false);
    }
  });

  it("does not read a bare no, or longer on its own, as a negation", () => {
    expect(statementWords("Take the longer path").negated).toBe(false);
    expect(statementWords("Set no-verify on hooks").negated).toBe(false);
  });

  it("keeps a stem that ends in ss", () => {
    expect(statementWords("Check the class").words.has("class")).toBe(true);
  });
});

describe("jaccard", () => {
  it("is 0 for two empty sets and the shared share otherwise", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(["a"]), new Set(["a"]))).toBe(1);
  });
});

describe("saysSame", () => {
  it("matches the same lesson worded with different grammar", () => {
    expect(saysSame("Run the tests before merging.", "Always run tests before merging")).toBe(true);
  });

  it("does not match a lesson and its opposite", () => {
    expect(saysSame("Run the tests before merging.", "Never run the tests before merging.")).toBe(false);
  });

  it("does not match two lessons that share only some words", () => {
    expect(saysSame("Use pnpm for installs in apps/web", "Use npm for installs in apps/api")).toBe(false);
  });
});

describe("contradicts", () => {
  it("matches a lesson that turns a record around", () => {
    expect(contradicts("Rebase the branch on main before pushing", "Never rebase the branch on main")).toBe(true);
    expect(contradicts("Avoid npm in this repository", "Use npm in this repository")).toBe(true);
  });

  it("does not match two lessons with the same polarity", () => {
    expect(contradicts("Never push to main", "Do not push to main")).toBe(false);
  });

  it("does not match opposite lessons about different things", () => {
    expect(contradicts("Never push to main", "Run the migration generator after a schema edit")).toBe(false);
  });
});
