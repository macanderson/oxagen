/**
 * working-copy.ts: what `oxagen init` and `oxagen pull` tell Oxagen about the
 * directory they ran in (`record_working_copy`, the Working copies tab on the
 * Repositories page).
 *
 * The report carries what this machine can see about the directory: its
 * path, the git remote, branch and head, whether `.oxagen/` holds anything
 * besides the link, whether Stella's links into `.oxagen/` resolve, and the
 * commit the last pull wrote. It never carries a file's contents.
 *
 * Every probe here is best-effort. A missing git binary, a directory outside
 * a repository or a slow disk turns a field into null, never into a thrown
 * error, because the report must not be the reason a command fails. Git runs
 * through `execFile` with an argument array (no shell) and a short timeout.
 *
 * `ensureWorkspaceLinkIgnored` lives here too: it is the other thing init
 * does to the working copy itself, and it needs the same git probe.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { apiPostOrThrow } from "./api.js";
import { getConfigDir } from "./config.js";

/** How long one git probe may take before its field reads null. */
const GIT_TIMEOUT_MS = 3_000;

/** How long the report itself may take. It is optional on both commands. */
const REPORT_TIMEOUT_MS = 8_000;

/** The file under the config directory that holds this machine's random id. */
const MACHINE_ID_FILE = "machine-id";

/** The links Stella keeps into `.oxagen/`, relative to the project root. */
export const STELLA_LINKS = [
  ".stella/rules",
  ".stella/proposals",
  ".stella/agents",
] as const;

/** Mirrors `workingCopySymlinksSchema` in the contract. */
export type SymlinkState = "linked" | "missing" | "none";

/** Mirrors `workingCopyEventSchema` in the contract. */
export type WorkingCopyEvent = "init" | "pull";

/** The `record_working_copy` input, field for field. */
export interface WorkingCopyReport {
  machineId: string;
  hostname: string;
  directory: string;
  repository: string | null;
  branch: string | null;
  headCommit: string | null;
  oxagenPresent: boolean;
  symlinks: SymlinkState;
  pulledCommit: string | null;
  event: WorkingCopyEvent;
  cliVersion: string | null;
}

/** The `record_working_copy` output. */
export interface WorkingCopyRecorded {
  workingCopyId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** What a command puts in its `--json` output for the report. */
export type WorkingCopyOutcome =
  | { workingCopyId: string; lastSeenAt: string }
  | { error: string };

const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

// ── git ──────────────────────────────────────────────────────────────────────

/** Run git with `args` in `cwd`; the trimmed stdout, or null on any failure. */
export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    try {
      execFile(
        "git",
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
        (err, stdout) => {
          if (err) return done(null);
          const out = String(stdout).trim();
          done(out.length > 0 ? out : null);
        },
      );
    } catch {
      done(null);
    }
  });
}

/**
 * The directory a command treats as the project: the git top level when `cwd`
 * is inside a work tree, else `cwd` itself, absolute.
 *
 * `oxagen steering` stops its search for `.oxagen/` at the repository root
 * (`findProjectRoot` in commands/steering.ts), so a link written in a
 * subdirectory of a repository was one the gate never read. Init writes the
 * link here, and pull and the working-copy report use the same root.
 */
export async function projectRootFor(cwd: string): Promise<string> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return top ? resolve(top) : resolve(cwd);
}

/**
 * `owner/name` from a git remote URL, or null when the URL names no
 * repository path. Handles `https://host/owner/name(.git)`,
 * `ssh://git@host[:port]/owner/name(.git)` and the scp form
 * `git@host:owner/name(.git)`. A host with nested groups keeps every group
 * segment (`group/sub/name`). Credentials in the URL are never returned: only
 * the path is read.
 */
export function parseRemoteRepository(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0) return null;
  let path: string | null = null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (!raw.includes("://") && scp) {
    // A Windows drive path (`C:\repo`) looks like scp to the regex above.
    if (scp[1]!.length === 1) return null;
    path = scp[2]!;
  } else {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "file:") return null;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const name = segments.join("/");
  return name.length >= 3 && name.length <= 512 ? name : null;
}

// ── .oxagen/ and .stella/ ────────────────────────────────────────────────────

/** Whether `<root>/.oxagen/` holds anything besides the machine's own link. */
export function oxagenPresent(root: string): boolean {
  try {
    return readdirSync(join(root, ".oxagen")).some(
      (name) => name !== "workspace.json",
    );
  } catch {
    return false;
  }
}

/**
 * The state of Stella's links into `.oxagen/`: `none` without a `.stella/`
 * directory, `linked` when all three are symlinks that resolve inside
 * `.oxagen/`, else `missing`.
 */
export function symlinkState(root: string): SymlinkState {
  try {
    if (!lstatSync(join(root, ".stella")).isDirectory()) return "none";
  } catch {
    return "none";
  }
  let oxagenReal: string;
  try {
    oxagenReal = realpathSync(join(root, ".oxagen"));
  } catch {
    return "missing";
  }
  for (const link of STELLA_LINKS) {
    const at = join(root, link);
    try {
      if (!lstatSync(at).isSymbolicLink()) return "missing";
      const target = realpathSync(at);
      if (target !== oxagenReal && !target.startsWith(oxagenReal + sep)) {
        return "missing";
      }
    } catch {
      // Absent, or a link whose target is gone.
      return "missing";
    }
  }
  return "linked";
}

// ── machine id ───────────────────────────────────────────────────────────────

/**
 * A stable id for this machine: the sha256 of a random 32-byte value kept in
 * the CLI's config directory, created on first use. No hardware serial is
 * read. When the directory cannot be written, the hash falls back to this
 * user's hostname and home directory, which is stable and still names no
 * hardware.
 */
export function machineId(configDir: string = getConfigDir()): string {
  const file = join(configDir, MACHINE_ID_FILE);
  let secret: string | null = null;
  try {
    if (existsSync(file)) {
      const stored = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(stored)) secret = stored;
    }
    if (secret === null) {
      secret = randomBytes(32).toString("hex");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(file, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    secret = `fallback:${osHostname()}:${homedir()}`;
  }
  return createHash("sha256").update(secret).digest("hex");
}

// ── the report ───────────────────────────────────────────────────────────────

/** The CLI's own version, as its package.json names it. */
export function cliVersion(): string | null {
  const v = (pkg as { version?: unknown }).version;
  return typeof v === "string" && v.length > 0 ? v.slice(0, 64) : null;
}

/**
 * Probe `root` and build the `record_working_copy` input. Never throws: every
 * field it cannot read becomes null (or `false` / `none`).
 */
export async function probeWorkingCopy(opts: {
  root: string;
  event: WorkingCopyEvent;
  pulledCommit?: string | null;
  configDir?: string;
}): Promise<WorkingCopyReport> {
  const { root } = opts;
  const [remote, branch, head] = await Promise.all([
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "HEAD"]),
  ]);
  const host = (() => {
    try {
      return osHostname().slice(0, 255);
    } catch {
      return "";
    }
  })();
  const pulled = opts.pulledCommit ?? null;
  return {
    machineId: machineId(opts.configDir),
    hostname: host.length > 0 ? host : "unknown",
    directory: resolve(root),
    repository: remote ? parseRemoteRepository(remote) : null,
    // `HEAD` is git's answer on a detached head.
    branch: branch && branch !== "HEAD" ? branch.slice(0, 255) : null,
    headCommit: head && COMMIT_SHA.test(head) ? head : null,
    oxagenPresent: oxagenPresent(root),
    symlinks: symlinkState(root),
    pulledCommit: pulled && COMMIT_SHA.test(pulled) ? pulled : null,
    event: opts.event,
    cliVersion: cliVersion(),
  };
}

/**
 * Probe `root` and send the report to the workspace `scope` names. Returns
 * the recorded id, or the error as text. Never throws.
 */
export async function reportWorkingCopy(opts: {
  root: string;
  scope: { org: string; ws: string };
  event: WorkingCopyEvent;
  pulledCommit?: string | null;
}): Promise<WorkingCopyOutcome> {
  try {
    const report = await probeWorkingCopy(opts);
    const recorded = await apiPostOrThrow<WorkingCopyRecorded>(
      "working-copies",
      report,
      opts.scope,
      { timeoutMs: REPORT_TIMEOUT_MS },
    );
    return {
      workingCopyId: recorded.workingCopyId,
      lastSeenAt: recorded.lastSeenAt,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// ── .gitignore ───────────────────────────────────────────────────────────────

/** The line init adds to `.gitignore`. */
export const WORKSPACE_LINK_IGNORE = ".oxagen/workspace.json";

/**
 * Make sure git ignores `<root>/.oxagen/workspace.json`. The link is one
 * machine's binding, so committing it would bind every clone to the same
 * workspace. Outside a git work tree nothing is touched.
 *
 * Returns the `.gitignore` path when a line was appended, else null.
 */
export async function ensureWorkspaceLinkIgnored(
  root: string,
): Promise<string | null> {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const topDir = resolve(top);
  // The link's path as the repository root's `.gitignore` names it. Init
  // passes the repository root, so this is `.oxagen/workspace.json`.
  const entry = relative(
    topDir,
    join(realpathOr(root), ".oxagen", "workspace.json"),
  )
    .split(sep)
    .join("/");
  if (entry.startsWith("../")) return null;
  // `check-ignore` exits 0 when the path is ignored and 1 when it is not,
  // and `git()` reads a non-zero exit as null. `--no-index` asks about the
  // rules alone, so a link that was committed by mistake still gets its line.
  const rule = await git(topDir, ["check-ignore", "--no-index", "-v", entry]);
  if (rule !== null) return null;
  const gitignore = join(resolve(top), ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignore, "utf8");
  } catch {
    // Absent: appendFileSync creates it.
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignore, `${prefix}${entry}\n`, "utf8");
  return gitignore;
}
