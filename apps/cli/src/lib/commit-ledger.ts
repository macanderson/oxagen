/**
 * The commit ledger — so an agent NEVER loses work.
 *
 * Every commit an agent makes is recorded as one append-only JSON line in
 * `~/.oxagen/commit-ledger.jsonl` (override with `OXAGEN_COMMIT_LEDGER`). The
 * ledger is deliberately append-only and plain-text rather than a mutable DB:
 * an interrupted write can at worst drop the last line, never corrupt history,
 * and the file stays human-readable for hand recovery. Each entry ties a commit
 * hash to the branch, working dir, task, and trace that produced it, so
 * `oxagen recover` can surface exactly what was done and how to restore it —
 * even for work on a branch that was later force-moved or a worktree that was
 * removed (the commit object still exists until git gc).
 *
 * Agents commit frequently with `--no-verify` ({@link commitWork}) so nothing
 * lives only in an uncommitted working tree; the final verification pass runs
 * before a PR is opened, not on every intermediate commit.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/** One recorded commit. Everything needed to find and restore the work later. */
export interface CommitLedgerEntry {
  /** Full 40-char commit SHA. */
  hash: string;
  /** Branch the commit was made on (best-effort; "" if detached/unknown). */
  branch: string;
  /** Absolute working directory (repo root) the commit was made in. */
  cwd: string;
  /** Commit subject line. */
  message: string;
  /** Files changed in this commit (relative paths). */
  files: string[];
  /** ISO-8601 UTC timestamp the entry was recorded. */
  at: string;
  /** Optional task id this commit belongs to (fleet/pipeline correlation). */
  taskId?: string;
  /** Optional trace id of the turn that produced it. */
  traceId?: string;
}

/** Resolve the ledger path. `OXAGEN_COMMIT_LEDGER` overrides (used by tests). */
export function ledgerPath(): string {
  return process.env["OXAGEN_COMMIT_LEDGER"] ?? join(homedir(), ".oxagen", "commit-ledger.jsonl");
}

/** Run a git command, returning trimmed stdout ("" on failure — never throws). */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Append one entry to the ledger. Best-effort and non-throwing: a failure to
 * record MUST NOT fail the agent's turn (the commit itself already succeeded —
 * losing a ledger line is recoverable via `git reflog`). Returns true on write.
 */
export function recordCommit(entry: CommitLedgerEntry): boolean {
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Read the ledger, newest first. Skips malformed lines. Filters are ANDed. */
export function readLedger(filter?: {
  cwd?: string;
  branch?: string;
  taskId?: string;
  limit?: number;
}): CommitLedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: CommitLedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as CommitLedgerEntry;
      if (!e || typeof e.hash !== "string") continue;
      if (filter?.cwd && e.cwd !== filter.cwd) continue;
      if (filter?.branch && e.branch !== filter.branch) continue;
      if (filter?.taskId && e.taskId !== filter.taskId) continue;
      out.push(e);
    } catch {
      /* skip a corrupt line rather than lose the whole ledger */
    }
  }
  out.reverse(); // newest first
  return filter?.limit ? out.slice(0, filter.limit) : out;
}

export interface CommitWorkResult {
  /** The new commit hash, or null when there was nothing to commit. */
  hash: string | null;
  /** True when an entry was written to the ledger. */
  recorded: boolean;
  /** Files in the commit (empty when nothing was committed). */
  files: string[];
}

/**
 * Stage everything and commit with `--no-verify`, then record it in the ledger.
 * This is the agent's "checkpoint now, never lose work" primitive: it commits
 * frequently and cheaply (hooks are skipped — the verification gate runs once
 * before the PR, not per commit). A clean tree is a no-op (`hash: null`), never
 * an error.
 *
 * `nowIso` is injectable for deterministic tests (defaults to the real clock).
 */
export function commitWork(
  cwd: string,
  message: string,
  meta: { taskId?: string; traceId?: string; nowIso?: string } = {},
): CommitWorkResult {
  // Nothing staged/unstaged? No-op — a checkpoint of nothing is not a failure.
  const status = git(["status", "--porcelain"], cwd);
  if (!status) return { hash: null, recorded: false, files: [] };

  git(["add", "-A"], cwd);
  // --no-verify: skip hooks; frequent checkpoints must be cheap.
  execFileSync("git", ["commit", "--no-verify", "-m", message], { cwd, encoding: "utf-8" });

  const hash = git(["rev-parse", "HEAD"], cwd);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], cwd)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const entry: CommitLedgerEntry = {
    hash,
    branch: branch === "HEAD" ? "" : branch,
    cwd,
    message: message.split("\n")[0] ?? message,
    files,
    at: meta.nowIso ?? new Date().toISOString(),
    ...(meta.taskId ? { taskId: meta.taskId } : {}),
    ...(meta.traceId ? { traceId: meta.traceId } : {}),
  };
  const recorded = recordCommit(entry);
  return { hash, recorded, files };
}

/** Does this commit object still exist in the repo at `cwd`? */
export function commitExists(hash: string, cwd: string): boolean {
  return git(["cat-file", "-t", hash], cwd) === "commit";
}
