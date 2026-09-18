/**
 * check.ts — the freshness verdict.
 *
 * ## The question
 *
 * "Has a Context PR merged onto the production branch that this checkout
 * does not have?" (ADR-061; `docs/specs/steering/README.md`.)
 *
 * ## Why the merge base, and not a directory comparison
 *
 * The obvious implementation compares the local `.oxagen/` tree against the
 * remote one and calls any difference staleness. It is wrong in the case
 * that matters most: a developer authoring a record has a `.oxagen/` that
 * differs from main *because they are writing the next record*, and a check
 * that cannot tell that apart from "main moved" would block the very work
 * the system exists to encourage, every time, until it was turned off.
 *
 * Git already separates the two. From the merge base of HEAD and the remote
 * production branch:
 *
 *   - changes on the REMOTE side are records that merged without this
 *     checkout — staleness, and the only thing that may block a run;
 *   - changes on the LOCAL side are records being authored here — never
 *     staleness, and never a reason to block.
 *
 * Both sides changed is `diverged`: still stale, and additionally unsafe to
 * sync without a human, because the sync would overwrite local authoring.
 *
 * ## Why it fails open
 *
 * Every failure path — no repository, no remote, no merge base, an
 * unreachable network, a git that is not installed — resolves to `unknown`,
 * which never blocks. A governance control that stops all work whenever its
 * own plumbing hiccups does not get to stay switched on, and a gate that is
 * switched off protects nothing. The reason is always carried so the banner
 * can say which plumbing failed rather than going quiet.
 */
import {
  commitsTouching,
  defaultBranch,
  diffPaths,
  dirtyPaths,
  execGit,
  fetchBranch,
  gitOrNull,
  isAncestor,
  mergeBase,
  parseNameStatus,
  repoRoot,
  revParse,
  treeOid,
  type GitContext,
  type GitRunner,
  type PathChange,
} from "./git";
import {
  readFetchStamp,
  shouldFetch,
  writeFetchStamp,
  type CacheIo,
} from "./cache";
import { PROJECT_DIR_NAME } from "./settings";
import type { SteeringPolicy } from "./policy";

/**
 * - `current`  — nothing merged here that this checkout lacks.
 * - `ahead`    — only this checkout changed `.oxagen/`. Authoring, not staleness.
 * - `behind`   — records merged on the production branch that this checkout lacks.
 * - `diverged` — behind, and this checkout also changed `.oxagen/`. A sync needs a human.
 * - `unknown`  — the question could not be answered. Never blocks.
 */
export type FreshnessStatus =
  | "current"
  | "ahead"
  | "behind"
  | "diverged"
  | "unknown";

/** The second, independent signal: what the platform says is in force. */
export interface PlatformSignal {
  /** Promotion-ledger length — the workspace's steering version. */
  steeringVersion: number;
  /** The commit the newest promotion published at, when the platform knows it. */
  headCommit: string | null;
  /** True when that commit is not reachable from this checkout's HEAD. */
  aheadOfCheckout: boolean;
}

export interface FreshnessVerdict {
  status: FreshnessStatus;
  /** Set on every status, including `current`, so a banner can name the branch. */
  remote: string;
  branch: string | null;
  /** Records that merged on the production branch and are missing here. */
  missing: PathChange[];
  /** `.oxagen/` changes made on this branch. Authoring; never blocks. */
  local: PathChange[];
  /** Working-copy paths under `.oxagen/` that differ from HEAD. */
  dirty: string[];
  /** Commits on the production branch touching `.oxagen/` that this lacks. */
  behindByCommits: number;
  /** Tree object id of `.oxagen/` at HEAD and on the production branch. */
  fingerprint: { local: string | null; remote: string | null };
  /** Whether the remote was contacted this run, and why not when it was not. */
  fetch: { attempted: boolean; ok: boolean; reason: string | null };
  /** Non-fatal explanations: why `unknown`, why the fetch failed, and so on. */
  notes: string[];
  platform: PlatformSignal | null;
}

/** Stale enough to warn about — and the only statuses blocking may act on. */
export function isStale(verdict: FreshnessVerdict): boolean {
  return verdict.status === "behind" || verdict.status === "diverged";
}

/**
 * Safe to overwrite `.oxagen/` from the production branch without a human?
 * Only when this checkout has neither uncommitted work nor committed
 * authoring in that directory.
 */
export function isSyncSafe(verdict: FreshnessVerdict): boolean {
  return (
    verdict.status === "behind" &&
    verdict.dirty.length === 0 &&
    verdict.local.length === 0
  );
}

export interface CheckOptions {
  /** Any directory inside the repository. */
  cwd: string;
  policy: SteeringPolicy;
  run?: GitRunner;
  /** Per git invocation. The whole check runs several. */
  timeoutMs?: number;
  /** Set false in a hook that must never touch the network. */
  allowNetwork?: boolean;
  now?: () => number;
  cacheIo?: CacheIo;
  /** Already-fetched platform signal, or a fetcher. Optional by design. */
  platform?: PlatformSignal | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The pathspec the whole feature operates over: the `.oxagen/` directory,
 * minus the policy's excludes.
 *
 * The include comes first because git only honours `:(exclude)` magic
 * alongside at least one positive pathspec — a list of nothing but excludes
 * silently matches everything, which would compare the entire repository.
 */
export function steeringPathspec(policy: SteeringPolicy): {
  include: string;
  pathspecs: string[];
} {
  return {
    include: PROJECT_DIR_NAME,
    pathspecs: [
      PROJECT_DIR_NAME,
      ...policy.exclude.map((p) => `:(exclude)${p}`),
    ],
  };
}

function unknown(
  base: Omit<FreshnessVerdict, "status">,
  note: string,
): FreshnessVerdict {
  return { ...base, status: "unknown", notes: [...base.notes, note] };
}

/**
 * Answer the freshness question for one checkout.
 *
 * Never throws for an ordinary failure: `unknown` with a note is the answer
 * when the question cannot be asked.
 */
export async function checkSteeringFreshness(
  opts: CheckOptions,
): Promise<FreshnessVerdict> {
  const {
    cwd,
    policy,
    run,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowNetwork = true,
    now = Date.now,
    cacheIo,
    platform = null,
  } = opts;

  const ctx: GitContext = { cwd, timeoutMs, run: run ?? execGit };

  const base: Omit<FreshnessVerdict, "status"> = {
    remote: policy.remote,
    branch: policy.branch,
    missing: [],
    local: [],
    dirty: [],
    behindByCommits: 0,
    fingerprint: { local: null, remote: null },
    fetch: { attempted: false, ok: false, reason: null },
    notes: [],
    platform,
  };

  const root = await repoRoot(ctx);
  if (!root) {
    return unknown(base, "this directory is not inside a git repository");
  }
  // Every later call is pinned to the repository root so a pathspec of
  // `.oxagen` means the same thing regardless of which subdirectory the
  // prompt was submitted from.
  const repoCtx: GitContext = { ...ctx, cwd: root };

  const head = await revParse(repoCtx, "HEAD");
  if (!head) {
    return unknown(base, "this repository has no commits yet");
  }

  const branch =
    policy.branch ??
    (await defaultBranch(repoCtx, policy.remote, { allowNetwork }));
  base.branch = branch;
  if (!branch) {
    return unknown(
      base,
      `could not work out the default branch of remote "${policy.remote}"`,
    );
  }

  const target = `${policy.remote}/${branch}`;

  if (allowNetwork) {
    const commonDir = await gitOrNull(repoCtx, "rev-parse", "--git-common-dir");
    // `--git-common-dir` can answer relatively (".git"); resolve it against
    // the root so the stamp lands in one place from every worktree.
    const stampDir = commonDir
      ? commonDir.startsWith("/")
        ? commonDir
        : `${root}/${commonDir}`
      : null;
    const stamp = stampDir ? await readFetchStamp(stampDir, cacheIo) : null;
    if (shouldFetch(stamp, target, policy.fetchIntervalSeconds, now())) {
      const result = await fetchBranch(repoCtx, policy.remote, branch);
      base.fetch = {
        attempted: true,
        ok: result.ok,
        reason: result.ok ? null : result.reason,
      };
      if (!result.ok) {
        base.notes.push(
          `could not reach ${policy.remote}; comparing against the copy already on disk`,
        );
      }
      if (stampDir) {
        await writeFetchStamp(
          stampDir,
          { attemptedAt: now(), target, ok: result.ok },
          cacheIo,
        );
      }
    } else {
      base.fetch = {
        attempted: false,
        ok: true,
        reason: `last checked less than ${policy.fetchIntervalSeconds}s ago`,
      };
    }
  } else {
    base.fetch = { attempted: false, ok: false, reason: "network not allowed" };
  }

  const remoteHead = await revParse(repoCtx, target);
  if (!remoteHead) {
    return unknown(
      base,
      `no remote-tracking branch ${target} on disk — run \`git fetch ${policy.remote}\``,
    );
  }

  const mergeBaseCommit = await mergeBase(repoCtx, head, remoteHead);
  if (!mergeBaseCommit) {
    return unknown(
      base,
      `HEAD and ${target} share no common ancestor, so there is nothing to compare`,
    );
  }

  const { include, pathspecs } = steeringPathspec(policy);

  // `diffPaths` and `dirtyPaths` run git directly and reject on any non-zero
  // exit — a timeout, an unreadable object, a worktree someone deleted under
  // us. This function's contract is that it never throws for an ordinary
  // failure, and the gate relies on it: an exception here escapes `steering
  // status` and `steering sync` as a crash, while the prompt hook catches it
  // and allows the run with none of the diagnostic note an `unknown` carries.
  // Silently allowing is the worst of the three outcomes, so the failure is
  // converted into the verdict the contract promises.
  let missing: PathChange[];
  let local: PathChange[];
  let dirty: string[];
  let behindByCommits: number;
  let localTree: string | null;
  let remoteTree: string | null;
  try {
    [missing, local, dirty, behindByCommits, localTree, remoteTree] =
      await Promise.all([
        diffPaths(repoCtx, mergeBaseCommit, remoteHead, pathspecs),
        diffPaths(repoCtx, mergeBaseCommit, head, pathspecs),
        dirtyPaths(repoCtx, pathspecs),
        commitsTouching(repoCtx, mergeBaseCommit, remoteHead, include),
        treeOid(repoCtx, head, include),
        treeOid(repoCtx, remoteHead, include),
      ]);
  } catch (error) {
    return unknown(
      base,
      `could not compare this checkout with ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Both merge-base diffs describe commits, and the question is about
  // files. Anything whose working copy already matches the production
  // branch is dropped from both sides, because git's commit arithmetic
  // keeps naming it long after it has stopped mattering:
  //
  //   - on the remote side, a sync writes the files without moving HEAD, so
  //     an unfiltered `missing` would have auto-sync and blocking refuse a
  //     prompt over records the sync wrote to disk a moment earlier;
  //   - on the local side, committing a sync makes those same paths look
  //     like this branch authored them, and the next sync would refuse as
  //     `diverged` to protect a file that is identical to main's.
  //
  // What survives is the honest pair: records in force that this checkout
  // would not read, and this checkout's own work that a sync would destroy.
  const [outstanding, authored] = await Promise.all([
    differingFromRemote(repoCtx, remoteHead, missing),
    differingFromRemote(repoCtx, remoteHead, local),
  ]);

  base.missing = outstanding;
  base.local = authored;
  base.dirty = dirty;
  base.behindByCommits = behindByCommits;
  base.fingerprint = { local: localTree, remote: remoteTree };

  if (platform?.aheadOfCheckout && outstanding.length === 0) {
    // The platform says a promotion published at a commit this checkout
    // cannot reach, while git says nothing merged. That is the case a pure
    // git comparison misses: a remote-tracking ref too old to have the
    // promotion in it, usually because the fetch failed. Report it as
    // staleness — the platform is the authority on what is in force — and
    // say which signal decided, so the banner is not mysterious.
    //
    // But `aheadOfCheckout` is computed against HEAD, and a sync deliberately
    // does not move HEAD: it writes and stages the files. So after a
    // successful auto-sync the signal still reads "ahead" while every record
    // it named is now on disk, and returning `behind` here made
    // `autoSync + blockStaleRuns` exit 2 immediately after installing
    // everything that was missing — refusing the prompt over nothing, with a
    // note naming a version the checkout was by then holding.
    //
    // What separates the two cases is the remote-tracking ref, not HEAD. If
    // the ref can reach the published commit then the fetch worked, git saw
    // the promotion, and `outstanding` being empty means the files are here:
    // the git comparison is complete and the platform adds nothing. If it
    // cannot — or the commit is not in this clone at all — the ref really is
    // too old and the platform is the only signal that knows.
    const refHasPromotion = platform.headCommit
      ? await isAncestor(repoCtx, platform.headCommit, remoteHead)
      : null;
    if (refHasPromotion !== true) {
      base.notes.push(
        `Oxagen reports steering version ${platform.steeringVersion}, published at a commit this checkout cannot reach`,
      );
      return { ...base, status: "behind" };
    }
  }

  // The status describes committed history only. Uncommitted work is
  // reported next to it in `dirty` rather than folded into it: a developer
  // with an unsaved edit has not diverged from the production branch, they
  // have an unsaved edit, and calling that `diverged` would put the wrong
  // words in the banner and make the sync's two refusals indistinguishable.
  // Both are consulted by `isSyncSafe`, which is the question dirt actually
  // bears on.
  if (outstanding.length === 0) {
    return { ...base, status: authored.length > 0 ? "ahead" : "current" };
  }
  return { ...base, status: authored.length > 0 ? "diverged" : "behind" };
}

/**
 * Keep only the candidate paths whose working copy differs from the
 * production branch.
 *
 * `git diff <commit> -- <paths>` compares those paths in the commit against
 * the working copy, so a path that comes back unchanged is one the checkout
 * already holds byte for byte, however it got there: a sync not yet
 * committed, a cherry-pick, a rebase, a developer who wrote the same record
 * by hand. Whatever the route, the agent will read the file that is in
 * force, which is the only thing the question was ever about.
 *
 * Batched so a very large rules directory cannot overrun the argv limit.
 */
async function differingFromRemote(
  ctx: GitContext,
  remoteHead: string,
  candidates: readonly PathChange[],
): Promise<PathChange[]> {
  if (candidates.length === 0) return [];
  const differing = new Set<string>();
  for (let i = 0; i < candidates.length; i += 200) {
    const batch = candidates.slice(i, i + 200).map((c) => c.path);
    const raw = await ctx.run(
      [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        remoteHead,
        "--",
        ...batch,
      ],
      { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs },
    );
    for (const change of parseNameStatus(raw)) differing.add(change.path);
  }
  return candidates.filter((c) => differing.has(c.path));
}
