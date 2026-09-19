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
 *   - out of time   — the caller shared a deadline (the gate does: the hook
 *                     the harness kills after 20 seconds) and too little of
 *                     it is left. Nothing is started, or what was started is
 *                     reported as unfinished. Either way `applied` is false,
 *                     so a blocking policy still blocks.
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
import {
  clampContextToDeadline,
  execGit,
  git,
  isSafeRefName,
  pathsInTree,
  revParse,
  type GitContext,
  type GitRunner,
} from "./git";
import type { FreshnessVerdict } from "./check";

export type SyncRefusal =
  | "not_behind"
  | "out_of_time"
  | "diverged"
  | "dirty"
  | "unknown_state"
  | "remote_ref_missing"
  | "remote_ref_stale";

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
  /**
   * An absolute deadline (as `now()` would report it) every git call this
   * sync makes is clamped to.
   *
   * A caller running inside a shared hook budget — `evaluateGate`'s
   * automatic sync — has already spent part of that budget on the check
   * before this runs, and the sync itself makes several git calls in
   * sequence (`restore`, `rm`, `clean`, `commit`). Each defaulting to the
   * full `timeoutMs` on its own let a slow one alone outlive the installed
   * hook's own timeout: the harness killed the process before the blocking
   * decision was rendered, and the prompt proceeded despite
   * `blockStaleRuns`, sometimes after only part of the sync had landed.
   * Unset for a standalone `steering sync` invocation, which owns no shared
   * budget and keeps the plain per-call `timeoutMs`.
   */
  deadlineMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The smallest slice a sync's git call may be given once its deadline is
 * nearly spent — long enough for a call already in flight to have a real
 * chance of finishing, matching the floor `checkSteeringFreshness` applies
 * to its own local git work.
 */
const MIN_SYNC_SLICE_MS = 1_000;

/**
 * The least time this sync will start a write with.
 *
 * Clamping alone bounds each call but not the run: with the deadline already
 * gone, every batch still got the {@link MIN_SYNC_SLICE_MS} floor, and a
 * large rules directory is many batches, so the sync could still outlive the
 * hook the harness kills. Under this much, the answer is `out_of_time` before
 * anything is touched, which leaves the working copy exactly as it was found.
 * Sized as four calls at the floor: the ref probe, a restore, an rm, and the
 * margin between them.
 */
export const MIN_SYNC_BUDGET_MS = MIN_SYNC_SLICE_MS * 4;

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
    deadlineMs,
    now = Date.now,
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

  // The same guard `checkSteeringFreshness` applies, repeated here because
  // this function takes a verdict from its caller and hands its remote and
  // branch straight to git. A name git could read as an option never gets
  // that far.
  if (
    !isSafeRefName(verdict.remote) ||
    (verdict.branch !== null && !isSafeRefName(verdict.branch))
  ) {
    return refuse(
      "unknown_state",
      `The steering remote or branch is not a valid git name, so nothing was synced.`,
    );
  }

  // Refused before the first write, not during it. Every refusal above is
  // this shape: a sync that cannot be done safely does nothing at all and
  // says why, and a sync that cannot be finished inside the hook's own
  // timeout is the same case. `applied` stays false, so a blocking policy
  // still refuses the prompt rather than the harness killing the gate and
  // letting it through over a part-written `.oxagen/`.
  if (deadlineMs !== undefined && deadlineMs - now() < MIN_SYNC_BUDGET_MS) {
    return refuse(
      "out_of_time",
      "The freshness check used the time this prompt's hook had, so nothing was synced. Run `oxagen steering sync` to pull `.oxagen/` forward.",
    );
  }

  const baseCtx: GitContext = { cwd, run, timeoutMs };
  // Only wrap when a caller handed us a shared budget. Clamping
  // unconditionally would floor every standalone `steering sync` call's
  // timeout to `MIN_SYNC_SLICE_MS` against a deadline nobody set.
  const ctx: GitContext =
    deadlineMs === undefined
      ? baseCtx
      : clampContextToDeadline(baseCtx, deadlineMs, MIN_SYNC_SLICE_MS, now);
  const target = verdict.branch
    ? `${verdict.remote}/${verdict.branch}`
    : verdict.remote;
  // The full ref, for the reason `check.ts` resolves it that way: a local
  // branch named `origin/main` wins git's DWIM over the remote-tracking ref,
  // and the sync would then restore from whatever that branch holds.
  const fromCommit = await revParse(
    ctx,
    verdict.branch
      ? `refs/remotes/${verdict.remote}/${verdict.branch}`
      : verdict.remote,
  );
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

  // `force` is the caller's word that local `.oxagen/` changes may be
  // overwritten, so a forced sync reconciles the whole governed tree to
  // production, not only what production changed. `missing` names the
  // paths production moved; a record this branch added on its own, or a
  // dirty file, is in `local` or `dirty` and nowhere in `missing`. Restoring
  // only `missing` (which this once did) left that local-only rule on disk
  // and reported `applied: true`, so the agent went on reading a record
  // production never held. Each such path takes production's copy when
  // production has it and is removed when it does not.
  if (force) {
    const listed = new Set([...updated, ...removed]);
    const extra = [
      ...verdict.local.map((c) => c.path),
      ...verdict.dirty,
    ].filter((path, i, all) => !listed.has(path) && all.indexOf(path) === i);
    const inProduction = new Set(await pathsInTree(ctx, fromCommit, extra));
    for (const path of extra) {
      if (inProduction.has(path)) updated.push(path);
      else removed.push(path);
    }
  }

  // Behind, but with nothing git can copy.
  //
  // This is exactly the case the platform fallback was added for: Oxagen knows
  // a promotion was published at a commit this checkout cannot reach, so the
  // verdict is `behind` — and `missing` is empty, because the remote-tracking
  // ref on disk does not contain that promotion for git to diff against. Every
  // filter above therefore yields nothing.
  //
  // Falling through wrote no files and still returned `applied: true` with
  // "0 file(s) synced". The gate then re-checked, found the same staleness,
  // refused the prompt again, and recommended the same command — a loop whose
  // every step reported success. The honest answer is that the remote copy on
  // disk is too old, and the repair is a fetch.
  if (updated.length === 0 && removed.length === 0) {
    return refuse(
      "remote_ref_stale",
      `Oxagen reports steering published at a commit ${target} does not contain, so there is nothing on disk to sync from. Run \`git fetch ${verdict.remote}\` and try again.`,
    );
  }

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

  // Checked between batches, not inside one. A deadline that arrives mid-run
  // leaves some files written, and the honest report of that is a refusal
  // naming it: `applied` false keeps the gate's verdict stale, so a blocking
  // policy blocks and the developer is told the tree is part-way rather than
  // being let through over a sync that reported success.
  let written = 0;
  const outOfBudget = (): boolean =>
    deadlineMs !== undefined && deadlineMs - now() < MIN_SYNC_SLICE_MS;
  const outOfTime = (): SyncResult =>
    refuse(
      "out_of_time",
      `The prompt's hook ran out of time after ${written} of ${
        updated.length + removed.length
      } file(s) under \`.oxagen/\` were taken from ${target}. Run \`oxagen steering sync\` to finish, or \`git restore --staged --worktree .oxagen\` to undo it.`,
    );

  if (updated.length > 0) {
    // `--staged --worktree` writes both the index and the file, so the result
    // is a staged change rather than an unexplained working-copy edit.
    // Batched in chunks so a repository with a very large rules directory
    // cannot overrun the platform's argv limit.
    for (const batch of chunk(updated, 200)) {
      if (outOfBudget()) return outOfTime();
      await git(
        ctx,
        "restore",
        `--source=${fromCommit}`,
        "--staged",
        "--worktree",
        // A sparse checkout keeps governed records in the index with the
        // skip-worktree bit set and no file on disk, and `restore` then
        // refuses their pathspecs. The check reports those records as
        // missing so that a sync puts them on disk; this is what lets it.
        "--ignore-skip-worktree-bits",
        "--",
        ...batch,
      );
      written += batch.length;
    }
  }
  if (removed.length > 0) {
    for (const batch of chunk(removed, 200)) {
      if (outOfBudget()) return outOfTime();
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
      written += batch.length;
    }
    // `git rm` removes what the index knows. A copy the developer left on
    // disk untracked or ignored, at a path production retired, is not in the
    // index, and `--ignore-unmatch` reported success over it. The check
    // counts such a copy as dirt, so this is reached only under `force`, and
    // `force` is the caller's word that the working copy may be overwritten:
    // the file goes too, or the sync says `applied` while the agent goes on
    // reading the retired record.
    if (force) {
      await git(ctx, "clean", "--quiet", "--force", "-x", "--", ...removed);
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
