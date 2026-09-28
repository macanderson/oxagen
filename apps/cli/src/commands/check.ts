/**
 * `oxagen check`: run the steering PR checks on a clone of a steering repo,
 * so you see what the PR check would report before you push.
 *
 * The head is the clone's working tree: every file git tracks or would add
 * (untracked and not ignored) among the files the steering PR check reads.
 * Those are AGENTS.md, CLAUDE.md, README.md, .gitattributes, and
 * workspace.toml at the root, and every file under agents/, steering/,
 * tools/, and policy/. The base is the production branch: `--base <ref>`,
 * else `origin/HEAD`, else `origin/main`. With no base the checks read the
 * head as a whole tree, as for a first publish.
 *
 * The cross-file checks read the published index and what Oxagen knows
 * outside the repository: runtimes, members, teams, reviewer groups, and
 * credentials. The command fetches both once from `get_steering_index`
 * (GET context/steering/index) and caches them for ten minutes under the
 * CLI's config directory. `--refresh` fetches them again.
 *
 * Two inputs the PR check can take stay out on a laptop. Nothing reads the
 * host's settings, so the settings check is skipped. No Cedar evaluator is
 * passed, so the compile check says it did not evaluate the policies.
 *
 * Paths narrow the report. The checks still read the whole tree, and the
 * report keeps the findings in those files and folders.
 *
 * Output (ADR-023 §4): the report goes to stdout. `--json` prints one finding
 * per line on stdout and the result line on stderr. Exit 0 when no finding is
 * an error, 1 when one is, and 2 when the checks cannot run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AGENTS_DIR,
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  GITATTRIBUTES_PATH,
  POLICY_DIR,
  README_PATH,
  STEERING_DIR,
  TOOLS_DIR,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import { workspaceSchema } from "@oxagen/oxagen/steering-repo/workspace";
import {
  formatHuman,
  runChecks,
  type CheckContext,
  type CheckReport,
  type CheckResult,
  type CheckStatus,
  type Finding,
  type IndexRecord,
  type SteeringTree,
} from "@oxagen/steering-check";
import { apiGetOrThrow } from "../lib/api.js";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { getConfigDir } from "../lib/config.js";
import { createOutput, errorMessage, type Output } from "../lib/output.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** What the cross-file checks read besides the tree. */
export interface PublishedInputs {
  /** The published index: the records of the workspace's bundle/v1. Null before the first publish. */
  index: { records: readonly IndexRecord[] } | null;
  /** What Oxagen knows outside the repository. */
  context: CheckContext;
}

/** What the command reads from outside the clone. Tests pass their own. */
export interface CheckDeps {
  /** Fetch the published index and context for the steering repo at `root`. Throws when it cannot. */
  fetchPublished: (root: string) => Promise<PublishedInputs>;
  /** The folder the fetched inputs are cached in, or null to fetch on every run. */
  cacheDir: string | null;
  /** Milliseconds since the epoch, for the cache's age. */
  now: () => number;
}

export interface CheckOptions {
  /** The ref to compare with, in place of origin/HEAD and origin/main. */
  base?: string;
  /** Fetch the published index again, even when the cached copy is fresh. */
  refresh?: boolean;
  /** Print one JSON object per finding. */
  json?: boolean;
}

// ── The files the steering PR check reads ────────────────────────────────────

/** The root files the steering PR check reads. */
const ROOT_FILES: readonly string[] = [
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  README_PATH,
  GITATTRIBUTES_PATH,
  WORKSPACE_TOML_PATH,
];

/** The folders the steering PR check reads every file under. */
const TREE_DIRS: readonly string[] = [
  AGENTS_DIR,
  STEERING_DIR,
  TOOLS_DIR,
  POLICY_DIR,
];

/** Git pathspecs for those files, relative to the steering repo's root. */
const PATHSPECS: readonly string[] = [...ROOT_FILES, ...TREE_DIRS];

/** The refs tried, in order, when `--base` is not given. */
const DEFAULT_BASES: readonly string[] = ["origin/HEAD", "origin/main"];

// ── Messages ─────────────────────────────────────────────────────────────────

const NOT_A_STEERING_REPO =
  "This directory is not in a steering repo. Run oxagen check inside a clone that holds workspace.toml, or AGENTS.md and steering/ for an organization repo.";

const NO_BASE = `No production branch to compare with. ${DEFAULT_BASES.join(" and ")} do not resolve in this clone, so the checks read the working tree whole. Pass --base <ref> to compare with a branch.`;

// ── git ──────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Run git in `cwd`: its raw stdout, or null when git fails or is missing. */
function git(
  cwd: string,
  args: readonly string[],
  input?: string,
): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      input,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** The entries of a `-z` listing. */
function nulSplit(out: Buffer): string[] {
  return out
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function insideWorkTree(root: string): boolean {
  return (
    git(root, ["rev-parse", "--is-inside-work-tree"])
      ?.toString("utf8")
      .trim() === "true"
  );
}

/** The commit `ref` names, or null when it names none. */
function commitOf(root: string, ref: string): string | null {
  const out = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = out?.toString("utf8").trim() ?? "";
  return sha.length > 0 ? sha : null;
}

/** A working-tree file's text. A symlink reads as its target, the way git stores it. */
function readWorkingFile(root: string, path: string): string | null {
  const abs = join(root, ...path.split("/"));
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return readlinkSync(abs, "utf8");
    return stat.isFile() ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * The head tree: each file git tracks or would add under the pathspecs,
 * read from the working tree. A tracked file deleted here is left out, as
 * the commit that deletes it would leave it out.
 */
export function readHead(root: string): Map<string, string> | null {
  const listed = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...PATHSPECS,
  ]);
  if (listed === null) return null;
  const files = new Map<string, string>();
  for (const path of [...new Set(nulSplit(listed))].sort()) {
    const text = readWorkingFile(root, path);
    if (text !== null) files.set(path, text);
  }
  return files;
}

/** The blobs `git cat-file --batch` printed, in the order they were asked for. */
function parseBatch(out: Buffer, count: number): string[] | null {
  const texts: string[] = [];
  let at = 0;
  while (texts.length < count) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) return null;
    const [, type, sizeText] = out.subarray(at, eol).toString("utf8").split(" ");
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isInteger(size) || size < 0) return null;
    const start = eol + 1;
    if (start + size > out.length) return null;
    texts.push(out.subarray(start, start + size).toString("utf8"));
    at = start + size + 1;
  }
  return texts;
}

/** The base tree: each blob under the pathspecs at `commit`. */
export function readBase(
  root: string,
  commit: string,
): Map<string, string> | null {
  const listed = git(root, ["ls-tree", "-r", "-z", commit, "--", ...PATHSPECS]);
  if (listed === null) return null;
  const blobs: Array<{ path: string; oid: string }> = [];
  for (const entry of nulSplit(listed)) {
    const tab = entry.indexOf("\t");
    const [, type, oid] = entry.slice(0, tab).split(" ");
    // A submodule is a commit, not a file, and the host lists no text for it.
    if (type === "blob" && oid !== undefined) {
      blobs.push({ path: entry.slice(tab + 1), oid });
    }
  }
  if (blobs.length === 0) return new Map();
  const out = git(
    root,
    ["cat-file", "--batch"],
    `${blobs.map((blob) => blob.oid).join("\n")}\n`,
  );
  const texts = out === null ? null : parseBatch(out, blobs.length);
  if (texts === null) return null;
  const sorted = blobs
    .map((blob, index) => [blob.path, texts[index] as string] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(sorted);
}

type BaseChoice =
  | { kind: "ref"; ref: string; commit: string }
  | { kind: "none" }
  | { kind: "missing"; ref: string };

function chooseBase(root: string, ref: string | undefined): BaseChoice {
  if (ref !== undefined) {
    const commit = ref.startsWith("-") ? null : commitOf(root, ref);
    return commit === null ? { kind: "missing", ref } : { kind: "ref", ref, commit };
  }
  for (const candidate of DEFAULT_BASES) {
    const commit = commitOf(root, candidate);
    if (commit !== null) return { kind: "ref", ref: candidate, commit };
  }
  return { kind: "none" };
}

// ── The steering repo ────────────────────────────────────────────────────────

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` to the steering repo's root: the nearest directory
 * that holds workspace.toml, or AGENTS.md and steering/ as an organization
 * repo does. Null when there is none.
 */
export function findSteeringRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (
      isFile(join(dir, WORKSPACE_TOML_PATH)) ||
      (isFile(join(dir, AGENTS_MD_PATH)) && isDir(join(dir, STEERING_DIR)))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Whether `path` is `scope` or lies under it. The empty scope is the whole repo. */
function within(path: string, scope: string): boolean {
  return scope === "" || path === scope || path.startsWith(`${scope}/`);
}

/** Each path argument as a repo-relative path, or the message that refuses it. */
function scopesFor(
  root: string,
  cwd: string,
  paths: readonly string[],
  trees: ReadonlyArray<SteeringTree | null>,
): { scopes: string[] } | { error: string } {
  const scopes: string[] = [];
  for (const path of paths) {
    const rel = relative(root, resolve(cwd, path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { error: `${path} is outside the steering repo at ${root}.` };
    }
    const scope = rel.split(sep).join("/");
    const known = trees.some(
      (tree) => tree !== null && [...tree.keys()].some((file) => within(file, scope)),
    );
    if (!known) {
      return { error: `${path} holds no file the steering PR check reads.` };
    }
    scopes.push(scope);
  }
  return { scopes };
}

// ── The published index ──────────────────────────────────────────────────────

/** How long a fetched index stays fresh. */
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

const CONTEXT_KEYS = [
  "runtimes",
  "members",
  "teams",
  "groups",
  "credentials",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Absent, null, or text: the index's optional fields. */
function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** A bundle record passes: the index holds a subset of its fields. */
function isIndexRecord(value: unknown): value is IndexRecord {
  if (!isObject(value)) return false;
  return (
    (["lineage", "path", "id", "hash", "kind"] as const).every(
      (key) => typeof value[key] === "string",
    ) &&
    isOptionalText(value.effect) &&
    isOptionalText(value.statement)
  );
}

/** The index and context in `value`, or null when either has the wrong shape. */
function asPublished(value: unknown): PublishedInputs | null {
  if (!isObject(value)) return null;
  const { index, context } = value;
  let records: IndexRecord[] | null = null;
  if (index !== null) {
    if (!isObject(index) || !Array.isArray(index.records)) return null;
    const listed: unknown[] = index.records;
    if (!listed.every(isIndexRecord)) return null;
    records = listed;
  }
  if (!isObject(context)) return null;
  const lists: Partial<Record<(typeof CONTEXT_KEYS)[number], string[]>> = {};
  for (const key of CONTEXT_KEYS) {
    const list = context[key];
    if (!isStringList(list)) return null;
    lists[key] = list;
  }
  return {
    index: records === null ? null : { records },
    context: {
      runtimes: lists.runtimes ?? [],
      members: lists.members ?? [],
      teams: lists.teams ?? [],
      groups: lists.groups ?? [],
      credentials: lists.credentials ?? [],
    },
  };
}

function cacheFile(cacheDir: string, root: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 32);
  return join(cacheDir, `${key}.json`);
}

/** The cached inputs when they are fresh and well formed, else null. */
function readCache(file: string, now: number): PublishedInputs | null {
  let entry: unknown;
  try {
    entry = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(entry) || typeof entry.fetched_at !== "string") return null;
  const age = now - Date.parse(entry.fetched_at);
  if (!(age >= 0 && age < CACHE_MAX_AGE_MS)) return null;
  return asPublished(entry);
}

/** The published inputs, from the cache while it is fresh, else fetched and cached. */
async function publishedInputs(
  root: string,
  deps: CheckDeps,
  refresh: boolean,
  out: Output,
): Promise<PublishedInputs> {
  const file = deps.cacheDir === null ? null : cacheFile(deps.cacheDir, root);
  if (file !== null && !refresh) {
    const cached = readCache(file, deps.now());
    if (cached !== null) return cached;
  }
  const fetched = asPublished(await deps.fetchPublished(root));
  if (fetched === null) {
    throw new Error(
      "The index Oxagen returned does not have the records and context the checks read.",
    );
  }
  if (file !== null) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      atomicWriteFileSync(
        file,
        JSON.stringify({
          fetched_at: new Date(deps.now()).toISOString(),
          ...fetched,
        }),
      );
    } catch (err) {
      out.warn(
        `Oxagen could not cache the published index at ${file}: ${errorMessage(err)}. The next run fetches it again.`,
      );
    }
  }
  return fetched;
}

/** The two slugs the index is read for. The schema check reports the rest of workspace.toml. */
const workspaceSlugs = workspaceSchema
  .pick({ organization: true, workspace: true })
  .passthrough();

/**
 * The organization and workspace a steering repo's workspace.toml names, or
 * undefined for an organization repo, which has no workspace.toml. Throws
 * when the file names no organization or no workspace, since then no one
 * index is the right one.
 */
function workspaceOf(root: string): { org: string; ws: string } | undefined {
  const text = readWorkingFile(root, WORKSPACE_TOML_PATH);
  if (text === null) return undefined;
  const read = readTomlFile(text, "workspace/v1", workspaceSlugs);
  if (!read.ok) {
    const [issue] = read.issues;
    throw new Error(
      `${WORKSPACE_TOML_PATH} does not name the organization and workspace to read the index for${issue === undefined ? "" : `: ${issue.message}`}. Fix ${WORKSPACE_TOML_PATH}, then run oxagen check again.`,
    );
  }
  return { org: read.value.organization, ws: read.value.workspace };
}

/**
 * The published index and context from `get_steering_index`. A workspace
 * repo reads the workspace its workspace.toml names. An organization repo
 * reads the context of the workspace the CLI has selected and no index, since
 * no organization version publishes yet, so its records check as a first
 * publish. The caller checks the answer's shape.
 */
async function fetchSteeringIndex(root: string): Promise<PublishedInputs> {
  const scope = workspaceOf(root);
  const answer = await apiGetOrThrow<PublishedInputs>(
    "context/steering/index",
    undefined,
    scope,
  );
  return scope === undefined ? { ...answer, index: null } : answer;
}

function defaultDeps(): CheckDeps {
  return {
    fetchPublished: fetchSteeringIndex,
    cacheDir: join(getConfigDir(), "cache", "steering-check"),
    now: () => Date.now(),
  };
}

// ── Narrowing the report ─────────────────────────────────────────────────────

function errorCount(findings: readonly Finding[]): number {
  return findings.filter((finding) => finding.severity === "error").length;
}

/** A check's count, in the words @oxagen/steering-check's summaries use. */
function countText(findings: readonly Finding[]): string {
  const errors = errorCount(findings);
  const warnings = findings.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings > 0) {
    parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  }
  return parts.length === 0 ? "No findings." : `${parts.join(" and ")}.`;
}

function statusOf(findings: readonly Finding[]): CheckStatus {
  if (errorCount(findings) > 0) return "failed";
  return findings.length > 0 ? "warned" : "passed";
}

/**
 * The report with only the findings in `scopes`. A finding with no path, as
 * when a check stops partway, stays. A check that loses findings gets its
 * status and count again, and keeps any note after the count.
 */
function narrow(report: CheckReport, scopes: readonly string[]): CheckReport {
  const keep = (finding: Finding) =>
    finding.path === "" || scopes.some((scope) => within(finding.path, scope));
  const results: CheckResult[] = report.results.map((entry) => {
    const findings = entry.findings.filter(keep);
    if (findings.length === entry.findings.length) return entry;
    const before = countText(entry.findings);
    const note = entry.summary.startsWith(before)
      ? entry.summary.slice(before.length)
      : "";
    return {
      ...entry,
      status: statusOf(findings),
      summary: `${countText(findings)}${note}`,
      findings,
    };
  });
  const findings = results.flatMap((entry) => entry.findings);
  return { passed: errorCount(findings) === 0, results, findings };
}

/** The report's last line: whether the steering PR passes, with its counts. */
function resultLine(report: CheckReport): string {
  const lines = formatHuman(report).trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

// ── Command ──────────────────────────────────────────────────────────────────

export async function check(
  paths: readonly string[] = [],
  opts: CheckOptions = {},
  writer: CommandWriter = stdoutWriter,
  cwd: string = process.cwd(),
  deps: Partial<CheckDeps> = {},
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const stop = (message: string, code: string): void => {
    out.error(message, code);
    process.exitCode = 2;
  };

  const root = findSteeringRoot(cwd);
  if (root === null) {
    stop(NOT_A_STEERING_REPO, "not_a_steering_repo");
    return;
  }
  if (!insideWorkTree(root)) {
    stop(
      `${root} is not in a git clone. oxagen check compares the working tree with the production branch, and reads both through git.`,
      "not_a_clone",
    );
    return;
  }

  const base = chooseBase(root, opts.base);
  if (base.kind === "missing") {
    stop(`--base ${base.ref} does not name a commit in this clone.`, "bad_base");
    return;
  }

  const head = readHead(root);
  if (head === null) {
    stop(`Oxagen could not list the files in ${root} with git.`, "git_failed");
    return;
  }
  let baseTree: Map<string, string> | null = null;
  if (base.kind === "ref") {
    baseTree = readBase(root, base.commit);
    if (baseTree === null) {
      stop(`Oxagen could not read ${base.ref} with git.`, "git_failed");
      return;
    }
  }

  const scoped = scopesFor(root, cwd, paths, [head, baseTree]);
  if ("error" in scoped) {
    stop(scoped.error, "bad_argument");
    return;
  }

  let published: PublishedInputs;
  try {
    published = await publishedInputs(
      root,
      { ...defaultDeps(), ...deps },
      opts.refresh === true,
      out,
    );
  } catch (err) {
    stop(
      `Oxagen could not fetch the published index. ${errorMessage(err)}`,
      "index_unavailable",
    );
    return;
  }

  if (base.kind === "ref") {
    out.info(`Compared with ${base.ref} at ${base.commit.slice(0, 7)}.`);
  } else {
    out.warn(NO_BASE);
  }

  const full = runChecks({
    files: head,
    base: baseTree,
    index: published.index,
    context: published.context,
    health: null,
  });
  const report =
    scoped.scopes.length === 0 ? full : narrow(full, scoped.scopes);
  const hidden = full.findings.length - report.findings.length;
  if (hidden > 0) {
    out.info(
      `The report shows the findings in ${paths.join(", ")}. It leaves out ${hidden} ${hidden === 1 ? "finding" : "findings"} in other files.`,
    );
  }

  if (out.isJson) {
    for (const finding of report.findings) out.event(finding);
    out.info(resultLine(report));
  } else {
    out.data(report, (value) => formatHuman(value as CheckReport).trimEnd());
  }
  if (!report.passed) process.exitCode = 1;
}
