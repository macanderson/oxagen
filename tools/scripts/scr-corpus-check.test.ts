import { describe, expect, it } from "vitest";
import {
  buildReport,
  CheckUnavailableError,
  corpusFilesFromTree,
  diverge,
  REPOS,
} from "./scr-corpus-check.mjs";

/**
 * These tests exist because of the defect oxagen #1132 documented in
 * stella-sidecar-nightly.yml: a drift check that is structurally incapable of
 * going red reports green forever and is worse than no check, because it
 * manufactures false confidence. Every divergence kind below is therefore
 * asserted to actually produce a divergence.
 */

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const IN_SYNC = {
  "docs/scr/README.md": "aaaaaaaa1111",
  "docs/scr/SCR-001-no-full-suite-builds.md": "bbbbbbbb2222",
};

describe("corpusFilesFromTree", () => {
  it("keeps only blobs under docs/scr/, mapped to their blob SHA", () => {
    const result = corpusFilesFromTree({
      truncated: false,
      tree: [
        { type: "blob", path: "docs/scr/README.md", sha: "aaa" },
        { type: "blob", path: "docs/adr/ADR-038.md", sha: "bbb" },
        { type: "tree", path: "docs/scr", sha: "ccc" },
        { type: "blob", path: "README.md", sha: "ddd" },
      ],
    });
    expect([...result.keys()]).toEqual(["docs/scr/README.md"]);
    expect(result.get("docs/scr/README.md")).toBe("aaa");
  });

  it("treats a truncated tree as check-broken, not as missing files", () => {
    // Silently accepting a truncated tree would report every dropped record as
    // `missing:` drift — a false alarm indistinguishable from a real one.
    expect(() => corpusFilesFromTree({ truncated: true, tree: [] })).toThrow(
      CheckUnavailableError,
    );
  });
});

describe("diverge", () => {
  it("reports nothing when the trees are byte-identical", () => {
    expect(diverge(files(IN_SYNC), files(IN_SYNC))).toEqual([]);
  });

  it("detects a record whose content changed on one side", () => {
    const drifted = diverge(
      files(IN_SYNC),
      files({ ...IN_SYNC, "docs/scr/README.md": "ffffffff9999" }),
    );
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toContain("differs: docs/scr/README.md");
    // Both SHAs appear so a reader can tell which copy they are looking at.
    expect(drifted[0]).toContain("aaaaaaaa");
    expect(drifted[0]).toContain("ffffffff");
  });

  it("detects a record missing from the candidate", () => {
    const drifted = diverge(
      files(IN_SYNC),
      files({ "docs/scr/README.md": "aaaaaaaa1111" }),
    );
    expect(drifted).toEqual([
      "missing: docs/scr/SCR-001-no-full-suite-builds.md",
    ]);
  });

  it("detects a record the candidate has and the reference does not", () => {
    // Drift is symmetric: a repo inventing a local SCR is as much a bug as one
    // dropping a shared record, so extras must not be silently tolerated.
    const drifted = diverge(
      files(IN_SYNC),
      files({ ...IN_SYNC, "docs/scr/SCR-099-local-invention.md": "eeee3333" }),
    );
    expect(drifted).toEqual(["extra:   docs/scr/SCR-099-local-invention.md"]);
  });

  it("reports every divergence at once rather than stopping at the first", () => {
    const drifted = diverge(
      files(IN_SYNC),
      files({
        "docs/scr/README.md": "ffffffff9999",
        "docs/scr/SCR-099-local-invention.md": "eeee3333",
      }),
    );
    expect(drifted).toHaveLength(3); // differs + missing + extra
  });
});

describe("buildReport", () => {
  const tree = (repo: string, entries: Record<string, string>) => ({
    repo,
    defaultBranch: "main",
    files: files(entries),
  });

  const allInSync = () => REPOS.map((repo) => tree(repo, IN_SYNC));

  it("is green when all five repos match the reference", () => {
    const { drifted, summary } = buildReport(allInSync());
    expect(drifted).toBe(false);
    expect(summary).toContain("`stella` — in sync (2 files)");
    // The reference repo describes itself in the header, not as a comparison row.
    expect(summary).not.toContain("`oxagen` — in sync");
  });

  it("goes red and names the offending repo when one copy drifts", () => {
    const trees = allInSync();
    trees[trees.length - 1] = tree("stella", {
      ...IN_SYNC,
      "docs/scr/README.md": "ffffffff9999",
    });
    const { drifted, summary } = buildReport(trees);
    expect(drifted).toBe(true);
    expect(summary).toContain("`stella` — **1 divergence(s)**");
    expect(summary).toContain("differs: docs/scr/README.md");
    expect(summary).toContain("`arenabench` — in sync");
  });

  it("refuses to run against an empty reference instead of blaming everyone", () => {
    // An empty oxagen tree — a bad checkout, a moved directory — would make
    // every other repo look like it invented the whole corpus. Failing as
    // check-broken keeps that from being filed as four drift issues.
    const trees = allInSync();
    trees[0] = tree("oxagen", {});
    expect(() => buildReport(trees)).toThrow(CheckUnavailableError);
  });
});
