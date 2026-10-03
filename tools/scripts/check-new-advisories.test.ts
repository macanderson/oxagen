/**
 * The guard that fails a pull request adding a high or critical dependency
 * advisory (#5062). Each test feeds it lockfiles: the base commit's through a
 * stand-in for git, and the tree under test's from a temporary checkout. The
 * stand-in for `pnpm audit` reads the lockfile in the directory it is handed
 * and reports an advisory for each vulnerable package it finds there, so the
 * tests prove the guard audits each tree's own lockfile without touching the
 * network.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_FILES,
  auditTree,
  baseArg,
  blockingFindings,
  checkNewAdvisories,
  newFindings,
  parseAudit,
} from "./check-new-advisories.mjs";

const BASE_SHA = "6b027e3aa2f12debd9c1c2ba3ddb9e877b18ea6d";

const MANIFEST = '{ "name": "oxagen-monorepo", "private": true }\n';
const WORKSPACE = 'packages:\n  - "apps/*"\n';

/** A pnpm lockfile whose `packages` section holds `entries`. */
const lockfile = (...entries: string[]) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "packages:",
    "",
    ...entries.map((entry) => `  ${entry}:\n    resolution: {integrity: sha512-x}\n`),
  ].join("\n");

interface Advisory {
  id: number;
  github_advisory_id: string;
  module_name: string;
  severity: string;
  title: string;
  url: string;
  version: string;
}

/** The advisories the stand-in database knows, keyed by name@version. */
const DATABASE: Record<string, Advisory[]> = {
  "tar@7.5.16": [
    {
      id: 1,
      github_advisory_id: "GHSA-23hp-3jrh-7fpw",
      module_name: "tar",
      severity: "critical",
      title: "node-tar: Decompression/parse DoS via unlimited input",
      url: "https://github.com/advisories/GHSA-23hp-3jrh-7fpw",
      version: "7.5.16",
    },
  ],
  "brace-expansion@1.1.15": [
    {
      id: 2,
      github_advisory_id: "GHSA-3jxr-9vmj-r5cp",
      module_name: "brace-expansion",
      severity: "high",
      title: "brace-expansion: DoS via exponential-time expansion",
      url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
      version: "1.1.15",
    },
  ],
  "brace-expansion@2.1.1": [
    {
      id: 2,
      github_advisory_id: "GHSA-3jxr-9vmj-r5cp",
      module_name: "brace-expansion",
      severity: "high",
      title: "brace-expansion: DoS via exponential-time expansion",
      url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
      version: "2.1.1",
    },
  ],
  "esbuild@0.18.20": [
    {
      id: 3,
      github_advisory_id: "GHSA-67mh-4wv8-2f99",
      module_name: "esbuild",
      severity: "moderate",
      title: "esbuild enables any website to send any requests to the development server",
      url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
      version: "0.18.20",
    },
  ],
};

/** The JSON `pnpm audit --json` prints for a lockfile, from DATABASE. */
function reportFor(lock: string): string {
  const advisories: Record<string, unknown> = {};
  for (const [pkg, list] of Object.entries(DATABASE)) {
    if (!lock.includes(`  ${pkg}:`)) continue;
    for (const advisory of list) {
      const { version, ...rest } = advisory;
      const key = String(advisory.id);
      const existing = advisories[key];
      const finding = { version, paths: [`.>${advisory.module_name}`] };
      if (
        existing !== null &&
        typeof existing === "object" &&
        "findings" in existing &&
        Array.isArray(existing.findings)
      ) {
        existing.findings.push(finding);
      } else {
        advisories[key] = { ...rest, findings: [finding] };
      }
    }
  }
  return JSON.stringify({ advisories, metadata: { vulnerabilities: {} } });
}

/** The stand-in for `pnpm audit --json`: audits the lockfile in `dir`. */
function fakeAudit(dir: string) {
  const lock = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
  return { status: 1, stdout: reportFor(lock), stderr: "" };
}

/** The stand-in for git, serving `files` as the base commit. */
function fakeGit(files: Record<string, string>) {
  return (args: string[]) => {
    if (args[0] === "rev-parse") {
      return args[2] === "HEAD^1^{commit}"
        ? { status: 0, stdout: `${BASE_SHA}\n`, stderr: "" }
        : { status: 128, stdout: "", stderr: "fatal: Needed a single revision" };
    }
    if (args[0] === "show") {
      const name = String(args[1]).replace(/^HEAD\^1:/, "");
      const content = files[name];
      return content === undefined
        ? { status: 128, stdout: "", stderr: `fatal: path '${name}' does not exist` }
        : { status: 0, stdout: content, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
  };
}

const noSleep = () => {};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-new-advisories-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes the tree under test: the manifest, the settings, and `lock`. */
function checkout(lock: string, workspace = WORKSPACE) {
  writeFileSync(join(root, "package.json"), MANIFEST);
  writeFileSync(join(root, "pnpm-workspace.yaml"), workspace);
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
}

/** The base commit's files around `lock`. */
const baseWith = (lock: string) => ({
  "package.json": MANIFEST,
  "pnpm-workspace.yaml": WORKSPACE,
  "pnpm-lock.yaml": lock,
});

describe("checkNewAdvisories", () => {
  it("fails when the lockfile under test adds a package with a critical advisory", () => {
    checkout(lockfile("debug@4.4.3", "tar@7.5.16"));
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lockfile("debug@4.4.3"))),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("::error::critical advisory GHSA-23hp-3jrh-7fpw in tar@7.5.16");
    expect(out).toContain("adds 1 high or critical finding");
    expect(out).toContain(BASE_SHA);
  });

  it("passes when the base commit already carries the same finding", () => {
    const lock = lockfile("debug@4.4.3", "tar@7.5.16");
    checkout(`${lock}\n`);
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lock)),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(0);
    expect(result.lines.join("\n")).toContain("carries 1 high or critical finding(s), and the tree under test carries 1");
  });

  it("fails on a second vulnerable version of a package the base already carries", () => {
    checkout(lockfile("brace-expansion@1.1.15", "brace-expansion@2.1.1"));
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lockfile("brace-expansion@1.1.15"))),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("brace-expansion@2.1.1");
    expect(out).not.toContain("in brace-expansion@1.1.15");
  });

  it("passes a change that adds only a moderate advisory", () => {
    checkout(lockfile("esbuild@0.18.20"));
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lockfile("debug@4.4.3"))),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(0);
  });

  it("passes a change that removes a finding", () => {
    checkout(lockfile("debug@4.4.3"));
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lockfile("debug@4.4.3", "tar@7.5.16"))),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(0);
  });

  it("passes without an audit when the three files match the base", () => {
    // A change that leaves the lockfile alone cannot add an advisory, so an
    // advisory outage must not fail it.
    const lock = lockfile("tar@7.5.16");
    checkout(lock);
    const audit = () => {
      throw new Error("audited a tree whose files match the base");
    };
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lock)),
      audit,
      sleep: noSleep,
    });
    expect(result.status).toBe(0);
    expect(result.lines.join("\n")).toContain("adds no advisory");
  });

  it("audits a settings change even when the lockfile is unchanged", () => {
    const lock = lockfile("tar@7.5.16");
    checkout(lock, `${WORKSPACE}auditConfig:\n  ignoreGhsas: []\n`);
    let audits = 0;
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lock)),
      audit: (dir: string) => {
        audits++;
        return fakeAudit(dir);
      },
      sleep: noSleep,
    });
    expect(result.status).toBe(0);
    expect(audits).toBe(2);
  });

  it("fails with exit 2 when the advisory request never answers", () => {
    checkout(lockfile("tar@7.5.16"));
    const sleeps: number[] = [];
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit(baseWith(lockfile("debug@4.4.3"))),
      audit: () => ({
        status: 1,
        stdout: "",
        stderr: "ERR_PNPM_AUDIT_BAD_RESPONSE Failed to request the audit endpoint",
      }),
      sleep: (ms: number) => sleeps.push(ms),
      attempts: 3,
    });
    expect(result.status).toBe(2);
    const out = result.lines.join("\n");
    expect(out).toContain("never answered");
    expect(out).toContain("ERR_PNPM_AUDIT_BAD_RESPONSE");
    expect(sleeps).toHaveLength(2);
  });

  it("fails with exit 2 when the base commit cannot be read", () => {
    checkout(lockfile("debug@4.4.3"));
    const result = checkNewAdvisories({
      base: "not-a-commit",
      root,
      git: fakeGit(baseWith(lockfile("debug@4.4.3"))),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(2);
    expect(result.lines.join("\n")).toContain("Cannot read the base commit");
  });

  it("fails with exit 2 when the base commit has no lockfile", () => {
    checkout(lockfile("debug@4.4.3"));
    const result = checkNewAdvisories({
      base: "HEAD^1",
      root,
      git: fakeGit({ "package.json": MANIFEST }),
      audit: fakeAudit,
      sleep: noSleep,
    });
    expect(result.status).toBe(2);
    expect(result.lines.join("\n")).toContain("no pnpm-lock.yaml");
  });
});

describe("auditTree", () => {
  it("audits a directory holding the tree's own files, then removes it", () => {
    const seen: { dir: string; names: string[]; lock: string }[] = [];
    const result = auditTree({
      files: {
        "package.json": MANIFEST,
        "pnpm-workspace.yaml": null,
        "pnpm-lock.yaml": lockfile("tar@7.5.16"),
      },
      audit: (dir: string) => {
        seen.push({
          dir,
          names: readdirSync(dir).sort(),
          lock: readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"),
        });
        return fakeAudit(dir);
      },
      sleep: noSleep,
    });
    expect("report" in result).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.names).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(seen[0]?.lock).toContain("tar@7.5.16");
    expect(() => readdirSync(seen[0]?.dir ?? "")).toThrow();
  });

  it("retries an audit that printed no report and keeps the next answer", () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = auditTree({
      files: { "pnpm-lock.yaml": lockfile("tar@7.5.16") },
      audit: (dir: string) => {
        calls++;
        return calls === 1 ? { status: 1, stdout: "", stderr: "connect ECONNRESET" } : fakeAudit(dir);
      },
      sleep: (ms: number) => sleeps.push(ms),
    });
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect("report" in result && blockingFindings(result.report)).toHaveLength(1);
  });
});

describe("parseAudit", () => {
  it("accepts a report", () => {
    expect(parseAudit(reportFor(lockfile("tar@7.5.16")))).not.toBeNull();
  });

  it.each([
    ["empty output", ""],
    ["text", "ERR_PNPM_AUDIT_BAD_RESPONSE"],
    ["an error object", '{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE"}}'],
    ["null", "null"],
    ["advisories without metadata", '{"advisories":{}}'],
  ])("rejects %s", (_label, stdout) => {
    expect(parseAudit(stdout)).toBeNull();
  });
});

describe("blockingFindings and newFindings", () => {
  it("keeps high and critical findings, one per advisory and version", () => {
    const report = parseAudit(
      reportFor(lockfile("brace-expansion@1.1.15", "brace-expansion@2.1.1", "esbuild@0.18.20")),
    );
    expect(report).not.toBeNull();
    const found = report === null ? [] : blockingFindings(report);
    expect(found.map((f) => f.key)).toEqual([
      "GHSA-3jxr-9vmj-r5cp brace-expansion@1.1.15",
      "GHSA-3jxr-9vmj-r5cp brace-expansion@2.1.1",
    ]);
    expect(newFindings(found.slice(0, 1), found).map((f) => f.version)).toEqual(["2.1.1"]);
  });
});

describe("baseArg", () => {
  it("reads --base", () => {
    expect(baseArg(["--base", "HEAD^1"])).toBe("HEAD^1");
  });

  it.each<[string[]]>([[[]], [["--base"]], [["--base", ""]], [["--base", "--other"]]])(
    "returns null for %j",
    (argv) => {
      expect(baseArg(argv)).toBeNull();
    },
  );
});

describe("AUDIT_FILES", () => {
  it("names the lockfile and both files pnpm reads its settings from", () => {
    expect([...AUDIT_FILES].sort()).toEqual(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  });
});
