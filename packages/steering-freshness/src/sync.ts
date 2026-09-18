/**
 * sync.ts — pulling `.oxagen/` forward from the production branch.
 *
 * ## What it refuses, and why it refuses so much
 *
 * A sync overwrites files in someone's working copy while they are mid-task.
 * It is the one part of this feature that can destroy work, so the bar is
 * high and the refusals are deliberately blunt:
 *
 *   - not `behind`  — there is nothing to pull, or the answer is `unknown`
 *                     and acting on a non-answer is how you delete a record
 *                     over a failed fetch.
 *   - `diverged`    — this branch changed `.oxagen/` too. Taking main's copy
 *                     would silently drop a record being authored. A person
 *                     resolves that, not a hook.
 *   - dirty         — uncommitted work anywhere under `.oxagen/`, even in a
 *                     file this sync would not touch. It is unreviewed, it is
 *                     not recoverable from git, and the sync's blast radius is
 *                     the directory, not the file list.
 *
 * `force` exists for the one case the refusals get wrong — a developer who
 * knows the local changes are disposable — and it still refuses on `unknown`,
 * because there is no such thing as a knowingly-correct sync to a state
 * nobody could compute.
 *
 * ## Why it stages but does not commit
 *
 * The files land staged. Committing them would put a commit into someone's
 * branch from inside a prompt submission, which is the kind of surprise that
 * gets automation revoked. Staged is visible in `git status`, survives, and
 * is one command from either outcome. `commit: true` is opt-in for the
 * developer who asked for it on the command line.
 */
import { execGit, git, revParse, type GitContext, type GitRunner } from "./git";
import type { FreshnessVerdict } from "./check";

export type SyncRefusal =
  | "not_behind"
  | "diverged"
  | "dirty"
  | "unknown_state"
  | "remote_ref_missing";

export interface SyncResult {
  applied: boolean;
  refusal: SyncRefusal | null;
  /** Human-readable, one sentence, safe to put straight in a banner. */
  message: string;
  /** Paths written into the working copy. */
  updated: string[];
  /** Paths removed because the production branch no longer carries them. */
  removed: string[];
  /** The commit `.oxagen/` was taken from. */
  fromCommit: string | null;
  committed: boolean;
}

export interface SyncOptions {
  cwd: string;
  verdict: FreshnessVerdict;
  run?: GitRunner;
  timeoutMs?: number;
  /** Overwrite local `.oxagen/` changes. Never bypasses `unknown`. */
  force?: boolean;
  /** Commit the synced files instead of leaving them staged. */
  commit?: boolean;
  /** Do everything except write. */
  dryRun?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function refuse(refusal: SyncRefusal, message: string): SyncResult {
  return {
    applied: false,
    refusal,
    message,
    updated: [],
    removed: [],
    fromCommit: null,
    committed: false,
  };
}

/** Take `.oxagen/` from the remote production branch into this working copy. */
export async function syncSteering(opts: SyncOptions): Promise<SyncResult> {
  const {
    cwd,
    verdict,
    run = execGit,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    force = false,
    commit = false,
    dryRun = false,
  } = opts;

  if (verdict.status === "unknown") {
    return refuse(
      "unknown_state",
      `Steering freshness could not be determined, so nothing was synced: ${
        verdict.notes[0] ?? "no reason given"
      }.`,
    );
  }
  if (verdict.status === "current" || verdict.status === "ahead") {
    return refuse(
      "not_behind",
      "`.oxagen/` already carries everything merged on the production branch.",
    );
  }
  if (verdict.status === "diverged" && !force) {
    return refuse(
      "diverged",
      `This branch has its own \`.oxagen/\` changes (${verdict.local
        .map((c) => c.path)
        .join(
          ", ",
        )}), so a sync would overwrite work in progress. Commit or set them aside, or re-run with --force.`,
    );
  }
  if (verdict.dirty.length > 0 && !force) {
    return refuse(
      "dirty",
      `\`.oxagen/\` has uncommitted changes (${verdict.dirty.join(
        ", ",
      )}), so it was left alone. Commit or discard them, or re-run with --force.`,
    );
  }

  const ctx: GitContext = { cwd, run, timeoutMs };
  const target = verdict.branch
    ? `${verdict.remote}/${verdict.branch}`
    : verdict.remote;
  const fromCommit = await revParse(ctx, target);
  if (!fromCommit) {
    return refuse(
      "remote_ref_missing",
      `${target} is not on disk, so there is nothing to sync from. Run \`git fetch ${verdict.remote}\`.`,
    );
  }

  const removed = verdict.missing
    .filter((c) => c.status === "removed")
    .map((c) => c.path);
  const updated = verdict.missing
    .filter((c) => c.status !== "removed")
    .map((c) => c.path);

  if (dryRun) {
    return {
      applied: false,
      refusal: null,
      message: `Would take ${updated.length + removed.length} file(s) under \`.oxagen/\` from ${target}.`,
      updated,
      removed,
      fromCommit,
      committed: false,
    };
  }

  if (updated.length > 0) {
    // `--staged --worktree` writes both the index and the file, so the result
    // is a staged change rather than an unexplained working-copy edit.
    // Batched in chunks so a repository with a very large rules directory
    // cannot overrun the platform's argv limit.
    for (const batch of chunk(updated, 200)) {
      await git(
        ctx,
        "restore",
        `--source=${fromCommit}`,
        "--staged",
        "--worktree",
        "--",
        ...batch,
      );
    }
  }
  if (removed.length > 0) {
    for (const batch of chunk(removed, 200)) {
      // `--ignore-unmatch` because a file the production branch deleted may
      // already be absent here; that is the desired end state, not an error.
      await git(
        ctx,
        "rm",
        "--quiet",
        "--force",
        "--ignore-unmatch",
        "--",
        ...batch,
      );
    }
  }

  let committed = false;
  if (commit && updated.length + removed.length > 0) {
    await git(
      ctx,
      "commit",
      "--no-verify",
      "-m",
      `chore(steering): sync .oxagen/ from ${target}`,
      "--",
      ...updated,
      ...removed,
    );
    committed = true;
  }

  return {
    applied: true,
    refusal: null,
    message: committed
      ? `Synced ${updated.length + removed.length} file(s) under \`.oxagen/\` from ${target} and committed them.`
      : `Synced ${updated.length + removed.length} file(s) under \`.oxagen/\` from ${target}. They are staged — commit them with your next change.`,
    updated,
    removed,
    fromCommit,
    committed,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
