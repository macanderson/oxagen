import { describe, expect, it } from "vitest";
import {
  buildReport,
  CheckUnavailableError,
  corpusFilesFromTree,
  REPOS,
} from "./scr-corpus-check.mjs";

/**
 * These tests exist because of the defect oxagen #1132 documented in
 * stella-sidecar-nightly.yml: a drift check that is structurally incapable of
 * going red reports green forever and is worse than no check, because it
 * manufactures false confidence. ADR-137 changed what red means. A leftover
 * docs/scr file must fail. An empty tree is the expected state, not a broken
 * check.
 */

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

describe("corpusFilesFromTree", () => {
  it("keeps only blobs under docs/scr/, mapped to their blob SHA", () => {
    const result = corpusFilesFromTree({
      truncated: false,
      tree: [
        { type: "blob", path: "docs/scr/README.md", sha: "aaa" },
        { type: "blob", path: "docs/adr/ADR-038.md", sha: "bbb" },
        { type: "tree", path: "docs/scr", sha: "ccc" },
        { type: "blob", path: "README.md", sha: "ddd" },
        { type: "blob", path: ".oxagen/rules/ctx.scr.001.toml", sha: "eee" },
      ],
    });
    expect([...result.keys()]).toEqual(["docs/scr/README.md"]);
    expect(result.get("docs/scr/README.md")).toBe("aaa");
  });

  it("treats a truncated tree as check-broken, not as an empty corpus", () => {
    // Silently accepting a truncated tree would report a clean repo that
    // dropped the leftover files. That is a false green.
    expect(() => corpusFilesFromTree({ truncated: true, tree: [] })).toThrow(
      CheckUnavailableError,
    );
  });
});

describe("buildReport", () => {
  const tree = (repo: string, entries: Record<string, string> = {}) => ({
    repo,
    defaultBranch: "main",
    files: files(entries),
  });

  const allClear = () => REPOS.map((repo) => tree(repo));

  it("is green when none of the five repos has a docs/scr file", () => {
    const { drifted, summary } = buildReport(allClear());
    expect(drifted).toBe(false);
    expect(summary).toContain("`stella`: no docs/scr/ files");
    expect(summary).toContain("`oxagen`: no docs/scr/ files");
    expect(summary).toContain("ADR-137");
  });

  it("goes red when another repo still carries the markdown corpus", () => {
    const trees = allClear();
    trees[trees.length - 1] = tree("stella", {
      "docs/scr/README.md": "aaaaaaaa",
      "docs/scr/SCR-001-no-full-suite-builds.md": "bbbbbbbb",
    });
    const { drifted, summary } = buildReport(trees);
    expect(drifted).toBe(true);
    expect(summary).toContain(
      "`stella`: **2 docs/scr/ file(s) still present**",
    );
    expect(summary).toContain("docs/scr/README.md");
    expect(summary).toContain("`arenabench`: no docs/scr/ files");
  });

  it("goes red when oxagen itself still carries docs/scr", () => {
    const trees = allClear();
    trees[0] = tree("oxagen", {
      "docs/scr/SCR-006-schema-changes-are-labelled.md": "cccccccc",
    });
    const { drifted, summary } = buildReport(trees);
    expect(drifted).toBe(true);
    expect(summary).toContain(
      "`oxagen`: **1 docs/scr/ file(s) still present**",
    );
  });
});
