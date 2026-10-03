#!/usr/bin/env node
/**
 * Fail a pull request that adds a high or critical dependency advisory (#5062).
 *
 * No CI step read the dependency advisories, so a pull request could add a
 * package with a known critical advisory and pass every check. Main's own
 * lockfile still carries advisories that wait on a major upgrade or on a fix
 * that does not exist yet, and #5062 lists each one with its reason. A step
 * that failed on every advisory would fail every pull request until that list
 * is empty. So this script runs two audits and fails only on a finding the
 * base commit does not have:
 *
 *   - the tree under test: the working tree, which in the checks job is the
 *     merge commit GitHub builds for the pull request, and
 *   - the base commit, read with `git show`.
 *
 * A finding is one advisory against one resolved version of one package. A
 * pull request that adds a second vulnerable version of a package main
 * already carries adds a finding. One that only adds another path to a version
 * main already resolves adds none.
 *
 * Both audits ask the advisory database at the same moment, so an advisory
 * published today against a package both trees carry shows up in both and
 * fails no pull request.
 *
 * `pnpm audit` reads the lockfile and the workspace settings and nothing else,
 * so each tree is audited from a temporary directory that holds its
 * `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml`. The settings
 * carry `auditConfig.ignoreGhsas`, so an advisory a pull request lists there,
 * with its reason beside it, drops out of that pull request's audit.
 *
 * A change that leaves all three files as they are at the base adds nothing,
 * so the script passes it without asking the advisory database.
 *
 * Otherwise the step fails closed. When the advisory request fails, pnpm
 * prints no JSON to stdout. An audit whose output is not a report is retried,
 * and when the last attempt fails too the script exits 2. An outage never
 * reads as a pass.
 *
 * Usage: node tools/scripts/check-new-advisories.mjs --base <commit>
 *   Exit 0: no new high or critical finding. 1: at least one new finding.
 *   2: an audit never answered, or a tree could not be read.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The files `pnpm audit` reads. Only the lockfile must exist. */
export const AUDIT_FILES = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];

/** The severities that fail a pull request. */
export const BLOCKING = new Set(["high", "critical"]);

export const ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const AUDIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * The audit report in `pnpm audit --json` output, or null when the output is
 * not one: empty, not JSON, or JSON without `advisories` and `metadata`.
 *
 * @param {string} stdout
 * @returns {{ advisories: Record<string, any>, metadata: Record<string, any> } | null}
 */
export function parseAudit(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { advisories, metadata } = parsed;
  if (advisories === null || typeof advisories !== "object") return null;
  if (metadata === null || typeof metadata !== "object") return null;
  return { advisories, metadata };
}

/**
 * @typedef {object} Finding
 * @property {string} key       advisory id, package and version
 * @property {string} advisory  the GHSA id, or pnpm's numeric id when it has none
 * @property {string} severity
 * @property {string} name      the package
 * @property {string} version   the resolved version the advisory covers
 * @property {string} title
 * @property {string} url
 * @property {string} path      one dependency path that reaches it
 */

/**
 * Every high or critical finding in an audit report, one per advisory and
 * resolved version.
 *
 * @param {{ advisories: Record<string, any> }} report
 * @returns {Finding[]}
 */
export function blockingFindings(report) {
  /** @type {Finding[]} */
  const found = [];
  for (const entry of Object.values(report.advisories)) {
    if (!BLOCKING.has(entry.severity)) continue;
    const advisory = String(entry.github_advisory_id ?? entry.id);
    for (const finding of entry.findings ?? []) {
      const version = String(finding.version);
      found.push({
        key: `${advisory} ${entry.module_name}@${version}`,
        advisory,
        severity: entry.severity,
        name: entry.module_name,
        version,
        title: entry.title ?? "",
        url: entry.url ?? "",
        path: finding.paths?.[0] ?? "",
      });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The findings in `head` that `base` does not have.
 *
 * @param {Finding[]} base
 * @param {Finding[]} head
 * @returns {Finding[]}
 */
export function newFindings(base, head) {
  const known = new Set(base.map((f) => f.key));
  return head.filter((f) => !known.has(f.key));
}

/**
 * Runs `pnpm audit --json` in `dir`.
 *
 * @param {string} dir
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runPnpmAudit(dir) {
  const result = spawnSync("pnpm", ["audit", "--json"], {
    cwd: dir,
    encoding: "utf8",
    timeout: AUDIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? String(result.error) : (result.stderr ?? ""),
  };
}

/**
 * Audits one tree from a temporary directory holding its audit files, and
 * retries an audit whose output is not a report. `pnpm audit` exits 1 both
 * when it finds an advisory and when the request fails, so the output, not
 * the exit status, says whether it answered.
 *
 * @param {object} options
 * @param {Record<string, string | null>} options.files  name to content; null skips the file
 * @param {(dir: string) => { status: number | null, stdout: string, stderr: string }} options.audit
 * @param {(ms: number) => void} options.sleep
 * @param {number} [options.attempts]
 * @returns {{ report: { advisories: Record<string, any>, metadata: Record<string, any> } } | { error: string }}
 */
export function auditTree({ files, audit, sleep, attempts = ATTEMPTS }) {
  const dir = mkdtempSync(join(tmpdir(), "oxagen-audit-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      if (content !== null) writeFileSync(join(dir, name), content);
    }
    let last = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = audit(dir);
      const report = parseAudit(result.stdout);
      if (report !== null) return { report };
      last = result.stderr.trim() || `pnpm audit exited ${result.status} with no report`;
      if (attempt < attempts) sleep(RETRY_DELAY_MS * attempt);
    }
    return { error: `pnpm audit gave no report after ${attempts} attempts. Last error: ${last}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs git in `cwd`.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * The audit files at a commit: name to content, null for a file the commit
 * does not have.
 *
 * @param {string} ref
 * @param {string} root
 * @param {typeof runGit} git
 * @returns {{ sha: string, files: Record<string, string | null> } | { error: string }}
 */
export function filesAt(ref, root, git) {
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`], root);
  if (commit.status !== 0) {
    return { error: `${ref} is not a commit in this checkout: ${commit.stderr.trim()}` };
  }
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const name of AUDIT_FILES) {
    const shown = git(["show", `${ref}:${name}`], root);
    files[name] = shown.status === 0 ? shown.stdout : null;
  }
  return { sha: commit.stdout.trim(), files };
}

/**
 * The audit files in the working tree under `root`.
 *
 * @param {string} root
 * @returns {Record<string, string | null>}
 */
export function filesIn(root) {
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const name of AUDIT_FILES) {
    try {
      files[name] = readFileSync(join(root, name), "utf8");
    } catch {
      files[name] = null;
    }
  }
  return files;
}

/** @param {Finding} f */
function formatFinding(f) {
  return [
    `${f.severity} ${f.name}@${f.version} ${f.advisory}: ${f.title}`,
    `    reached through ${f.path}`,
    `    ${f.url}`,
  ].join("\n");
}

/**
 * Compares the audit of the tree under `root` with the audit of `base`.
 * `main()` drives this seam with the real git and pnpm; tests pass their own.
 *
 * @param {object} options
 * @param {string} options.base   the commit the pull request merges into
 * @param {string} options.root   the checkout under test
 * @param {typeof runGit} [options.git]
 * @param {typeof runPnpmAudit} [options.audit]
 * @param {(ms: number) => void} [options.sleep]
 * @param {number} [options.attempts]
 * @returns {{ status: 0 | 1 | 2, lines: string[] }}
 */
export function checkNewAdvisories({
  base,
  root,
  git = runGit,
  audit = runPnpmAudit,
  sleep = sleepSync,
  attempts = ATTEMPTS,
}) {
  const baseFiles = filesAt(base, root, git);
  if ("error" in baseFiles) {
    return { status: 2, lines: [`::error::Cannot read the base commit. ${baseFiles.error}`] };
  }
  const headFiles = filesIn(root);
  if (baseFiles.files["pnpm-lock.yaml"] === null) {
    return { status: 2, lines: ["::error::The base commit has no pnpm-lock.yaml to audit."] };
  }
  if (headFiles["pnpm-lock.yaml"] === null) {
    return { status: 2, lines: ["::error::The tree under test has no pnpm-lock.yaml to audit."] };
  }
  // The same three files give the same audit, so a change that leaves them
  // alone adds nothing, and an advisory outage cannot fail it.
  if (AUDIT_FILES.every((name) => baseFiles.files[name] === headFiles[name])) {
    return {
      status: 0,
      lines: [`This change leaves ${AUDIT_FILES.join(", ")} as they are at ${baseFiles.sha}, so it adds no advisory.`],
    };
  }

  const baseAudit = auditTree({ files: baseFiles.files, audit, sleep, attempts });
  if ("error" in baseAudit) {
    return { status: 2, lines: [`::error::The audit of the base commit never answered. ${baseAudit.error}`] };
  }
  const headAudit = auditTree({ files: headFiles, audit, sleep, attempts });
  if ("error" in headAudit) {
    return { status: 2, lines: [`::error::The audit of the tree under test never answered. ${headAudit.error}`] };
  }

  const before = blockingFindings(baseAudit.report);
  const after = blockingFindings(headAudit.report);
  const added = newFindings(before, after);
  const lines = [
    `The base commit ${baseFiles.sha} carries ${before.length} high or critical finding(s), and the tree under test carries ${after.length}.`,
    "This step fails only on a finding the base commit does not carry.",
  ];
  if (added.length === 0) {
    lines.push("This change adds no high or critical advisory.");
    return { status: 0, lines };
  }
  lines.push(`This change adds ${added.length} high or critical finding(s):`);
  for (const f of added) {
    lines.push(`::error::${f.severity} advisory ${f.advisory} in ${f.name}@${f.version}`);
    lines.push(formatFinding(f));
  }
  lines.push(
    "Upgrade the dependency that brings each one in, or add an override in pnpm-workspace.yaml pinned to the first patched version.",
    "If no patched version exists and nothing in Oxagen reaches the code, add the GHSA id to auditConfig.ignoreGhsas in pnpm-workspace.yaml with a comment that says why.",
  );
  return { status: 1, lines };
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string[]} argv
 * @returns {string | null}
 */
export function baseArg(argv) {
  const i = argv.indexOf("--base");
  const value = i === -1 ? undefined : argv[i + 1];
  return value === undefined || value === "" || value.startsWith("--") ? null : value;
}

function main() {
  const base = baseArg(process.argv.slice(2));
  if (base === null) {
    console.error("Usage: node tools/scripts/check-new-advisories.mjs --base <commit>");
    process.exit(2);
  }
  const { status, lines } = checkNewAdvisories({ base, root: repoRoot });
  for (const line of lines) console.log(line);
  process.exit(status);
}

if (isEntrypoint(import.meta.url)) main();
