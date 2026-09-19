/**
 * The guard for #3237: a squash merge applies a branch's diff against its
 * merge base, not against main's current tip, so a branch cut before a later
 * fix can silently overwrite it with no conflict and no red check.
 *
 * `fileMergeRisk` and friends are pure and tested against string fixtures
 * that reproduce the exact incident: #3222 added a `purpose ===
 * CLI_SESSION_SCOPE_PURPOSE` exemption to `machine-key-scope.ts`; #3178's
 * branch, cut before that merge, still carried the old file. `runCheck` is
 * tested against a real temporary git repository built to the same shape,
 * so the proof holds at the git-plumbing level this script actually runs,
 * not only at the level of hand-picked strings.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileLines,
  fileMergeRisk,
  intersectFiles,
  linesAddedByMain,
  renderReport,
  runCheck,
} from "./check-stale-merge-base.mjs";

/**
 * `runCheck`'s per-file result shape, restated here because it is imported
 * from a `.mjs` module with no type declarations of its own.
 */
interface FileRisk {
  path: string;
  atRisk: boolean;
  missingLines: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Pure functions, string fixtures shaped on the real incident
// ---------------------------------------------------------------------------

const BASE_FILE = [
  "export async function machineKeyDenial(check) {",
  "  const { purpose } = check;",
  "  const allowed = MACHINE_KEY_CAPABILITIES[purpose];",
  "  if (allowed === undefined) {",
  "    return `Forbidden: this credential is bound to ${purpose}, which this deployment does not recognise.`;",
  "  }",
  "  return allowed.has(check.capabilityName) ? undefined : `Forbidden`;",
  "}",
].join("\n");

// main after #3222: adds the CLI session exemption ahead of the fail-closed branch.
const MAIN_WITH_FIX = [
  "export async function machineKeyDenial(check) {",
  "  const { purpose } = check;",
  "  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {",
  "    return check.userId ? undefined : `Forbidden: no person resolved`;",
  "  }",
  "  const allowed = MACHINE_KEY_CAPABILITIES[purpose];",
  "  if (allowed === undefined) {",
  "    return `Forbidden: this credential is bound to ${purpose}, which this deployment does not recognise.`;",
  "  }",
  "  return allowed.has(check.capabilityName) ? undefined : `Forbidden`;",
  "}",
].join("\n");

// #3178's branch: cut before #3222, carries the pre-fix file untouched.
const BRANCH_STILL_STALE = BASE_FILE;

describe("fileLines", () => {
  it("drops one trailing empty line but keeps interior blanks", () => {
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});

describe("linesAddedByMain", () => {
  it("finds the exemption lines #3222 added and nothing else", () => {
    const added = linesAddedByMain(BASE_FILE, MAIN_WITH_FIX);
    expect(added).toContain("  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {");
    expect(added).toContain(
      "    return check.userId ? undefined : `Forbidden: no person resolved`;",
    );
    // Unchanged lines (the fail-closed branch, the function signature) must
    // not be reported as "added" just because they still exist.
    expect(added).not.toContain(
      "export async function machineKeyDenial(check) {",
    );
  });

  it("reports nothing when main made no change", () => {
    expect(linesAddedByMain(BASE_FILE, BASE_FILE)).toEqual([]);
  });
});

describe("intersectFiles", () => {
  it("keeps only files touched on both sides, sorted", () => {
    expect(
      intersectFiles(
        ["b.ts", "a.ts", "only-branch.ts"],
        ["a.ts", "b.ts", "only-main.ts"],
      ),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("is empty when the two sides touch disjoint files", () => {
    expect(intersectFiles(["a.ts"], ["b.ts"])).toEqual([]);
  });
});

describe("fileMergeRisk", () => {
  it("flags the #3222/#3178 shape: branch lacks the lines main added", () => {
    const risk = fileMergeRisk({
      baseContent: BASE_FILE,
      mainContent: MAIN_WITH_FIX,
      branchContent: BRANCH_STILL_STALE,
    });
    expect(risk.atRisk).toBe(true);
    expect(risk.missingLines).toContain(
      "  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {",
    );
    expect(risk.reason).toMatch(/lacks/);
  });

  it("does not flag a branch whose copy already carries main's addition", () => {
    // e.g. the branch merged main in, or made the identical change itself.
    const risk = fileMergeRisk({
      baseContent: BASE_FILE,
      mainContent: MAIN_WITH_FIX,
      branchContent: MAIN_WITH_FIX,
    });
    expect(risk.atRisk).toBe(false);
  });

  it("does not flag a file main only deleted lines from", () => {
    const risk = fileMergeRisk({
      baseContent: MAIN_WITH_FIX,
      mainContent: BASE_FILE,
      branchContent: "unrelated content the branch wrote",
    });
    expect(risk.atRisk).toBe(false);
    expect(risk.reason).toMatch(/added no new lines/);
  });

  it("does not flag two sides that ended up identical", () => {
    const risk = fileMergeRisk({
      baseContent: BASE_FILE,
      mainContent: "shared content",
      branchContent: "shared content",
    });
    expect(risk.atRisk).toBe(false);
  });
});

describe("renderReport", () => {
  it("names the at-risk file and the missing lines", () => {
    const report = {
      upToDate: false as const,
      mergeBase: "abcdef0123456789",
      mainTip: "1234567890abcdef",
      files: [
        {
          path: "packages/iam/src/machine-key-scope.ts",
          atRisk: true,
          missingLines: ["  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {"],
          reason: "branch's copy of this file lacks 1 line(s) main added",
        },
      ],
    };
    const rendered = renderReport(report);
    expect(rendered).toContain("packages/iam/src/machine-key-scope.ts");
    expect(rendered).toContain("CLI_SESSION_SCOPE_PURPOSE");
    expect(rendered).toContain("1 of 1 file(s)");
  });

  it("says nothing is at risk when the file list is empty", () => {
    const rendered = renderReport({
      upToDate: false as const,
      mergeBase: "abcdef0123456789",
      mainTip: "1234567890abcdef",
      files: [],
    });
    expect(rendered).toContain("Nothing here");
  });

  it("reports up to date without scanning files", () => {
    expect(renderReport({ upToDate: true as const, files: [] })).toContain(
      "up to date",
    );
  });
});

// ---------------------------------------------------------------------------
// runCheck against a real git repository, built to the incident's shape
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, path: string, content: string, message: string) {
  writeFileSync(join(cwd, path), content);
  git(cwd, ["add", path]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    message,
  ]);
}

describe("runCheck against a real repository", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "stale-merge-base-"));
    git(repo, ["init", "-q", "-b", "main"]);
    commit(repo, "gate.ts", BASE_FILE, "initial: pre-fix machine-key-scope");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("scopes to files touched on both sides: an untouched fix stays out of scope", () => {
    // The branch is cut here, before the fix lands on main.
    git(repo, ["branch", "feature"]);

    // The fix merges to main.
    commit(
      repo,
      "gate.ts",
      MAIN_WITH_FIX,
      "iam: CLI session key exemption (#3222)",
    );

    // The branch, unaware of the fix, makes an UNRELATED change to a
    // different file. This check only scans files changed on both sides, so
    // a fix the branch never touched at all stays out of its scope; the
    // next test proves the case where the branch DID touch the fixed file,
    // which is where a squash merge can drop the fix.
    git(repo, ["checkout", "-q", "feature"]);
    commit(
      repo,
      "unrelated.ts",
      "export const x = 1;\n",
      "unrelated sweep change",
    );

    const report = runCheck({
      branchRef: "feature",
      mainRef: "main",
      cwd: repo,
    });

    expect(report.upToDate).toBe(false);
    expect(report.files.map((f: FileRisk) => f.path)).not.toContain("gate.ts");
  });

  it("catches the #3222/#3178 shape: the branch's own stale copy of the fixed file", () => {
    git(repo, ["branch", "feature"]);
    commit(
      repo,
      "gate.ts",
      MAIN_WITH_FIX,
      "iam: CLI session key exemption (#3222)",
    );

    // The branch independently touches gate.ts too (its own unrelated edit
    // to the file, made from the stale pre-fix copy), the shape that makes
    // git's merge machinery actually contend over the file rather than
    // ignore it.
    git(repo, ["checkout", "-q", "feature"]);
    commit(
      repo,
      "gate.ts",
      BASE_FILE.replace(
        "MACHINE_KEY_CAPABILITIES",
        "MACHINE_KEY_CAPABILITIES_V2",
      ),
      "unrelated rename on the stale branch",
    );

    const report = runCheck({
      branchRef: "feature",
      mainRef: "main",
      cwd: repo,
    });

    expect(report.upToDate).toBe(false);
    const gate = report.files.find((f: FileRisk) => f.path === "gate.ts");
    expect(gate).toBeDefined();
    expect(gate?.atRisk).toBe(true);
    expect(gate?.missingLines.join("\n")).toContain(
      "CLI_SESSION_SCOPE_PURPOSE",
    );

    const rendered = renderReport(report);
    expect(rendered).toContain("gate.ts");
    expect(rendered).toContain("at risk");
  });

  it("raises no alarm when the branch already contains main's tip", () => {
    git(repo, ["branch", "feature"]);
    commit(
      repo,
      "gate.ts",
      MAIN_WITH_FIX,
      "iam: CLI session key exemption (#3222)",
    );
    git(repo, ["checkout", "-q", "feature"]);
    git(repo, ["merge", "-q", "main"]);

    const report = runCheck({
      branchRef: "feature",
      mainRef: "main",
      cwd: repo,
    });

    expect(report.upToDate).toBe(true);
    expect(report.files).toEqual([]);
    expect(renderReport(report)).toContain("up to date");
  });

  it("raises no alarm when the two sides touch different files", () => {
    git(repo, ["branch", "feature"]);
    commit(
      repo,
      "gate.ts",
      MAIN_WITH_FIX,
      "iam: CLI session key exemption (#3222)",
    );
    git(repo, ["checkout", "-q", "feature"]);
    commit(
      repo,
      "other.ts",
      "export const y = 2;\n",
      "feature work, different file",
    );

    const report = runCheck({
      branchRef: "feature",
      mainRef: "main",
      cwd: repo,
    });

    expect(report.upToDate).toBe(false);
    expect(report.files).toEqual([]);
    expect(renderReport(report)).toContain("Nothing here");
  });

  it("raises no alarm when both sides changed the file but the branch kept the fix", () => {
    git(repo, ["branch", "feature"]);
    commit(
      repo,
      "gate.ts",
      MAIN_WITH_FIX,
      "iam: CLI session key exemption (#3222)",
    );
    git(repo, ["checkout", "-q", "feature"]);
    // The branch made its OWN edit to the file, but from a copy that already
    // has the fix (e.g. it was cut after #3222, or rebased since).
    commit(
      repo,
      "gate.ts",
      `${MAIN_WITH_FIX}\n// a trailing branch-only comment\n`,
      "feature: comment on the fixed file",
    );

    const report = runCheck({
      branchRef: "feature",
      mainRef: "main",
      cwd: repo,
    });

    const gate = report.files.find((f: FileRisk) => f.path === "gate.ts");
    expect(gate).toBeDefined();
    expect(gate?.atRisk).toBe(false);
  });
});
