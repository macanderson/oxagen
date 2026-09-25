/**
 * The collector daemon's git-read lane: which sessions want their worktree
 * read, when a read is due, the reads themselves, and the frames they seal.
 *
 * It lives beside the daemon rather than inside it because it is one
 * concern with one set of inputs. The daemon owns the hook queue, the
 * session registry, the WAL, and the pending SessionEnd journal, and hands
 * the lane what it needs from each through `GitLaneDeps`. The lane owns the
 * per-session read requests, the reconciliation throttle, and the cache of
 * git facts per worktree.
 *
 * The daemon still decides when the lane runs (`startGitReads`) and settles
 * a pending SessionEnd (`settleEnding`), because both are about the hook
 * queue and the chain's terminal, which are the daemon's.
 */
import { jsonContent } from "../evidence/frame-body";
import type { TachoEvent } from "../envelope";
import type { ExecAsync } from "../host/service";
import {
  type GitFacts,
  readGitFacts,
  readGitRoot,
  readPreexistingPaths,
  readSessionChanges,
  type SessionChanges,
  worktreeReconciledBody,
} from "./git-facts";
import {
  rememberBaseline,
  rememberForRoot,
  type SessionRecord,
  type SessionRegistry,
} from "./registry";
import type { HookEnvelope } from "./server";
import {
  readWorktreeSnapshot,
  type WorktreeSnapshot,
} from "./worktree-snapshot";

/**
 * The `pre_session_changes` attr of a reconciliation frame: whether the
 * uncommitted edits a worktree held before the session are in its list.
 */
const PRE_SESSION_CHANGES: Record<SessionChanges["preexisting"], string> = {
  complete: "excluded",
  partial: "partly_excluded",
  none: "included",
};

/**
 * Whether a session holds a baseline commit, which a session restored from
 * an older state file does without holding `gitFirstReadAt`.
 */
function holdsBaseline(session: SessionRecord): boolean {
  return (
    session.baselineCommit !== undefined ||
    Object.keys(session.baselines ?? {}).length > 0
  );
}

/**
 * When the session started, in epoch ms, for deciding whether a dirty file
 * predates it. The registry's first sight of the session, and never later
 * than the read happening now.
 */
function startedAtOf(session: SessionRecord, at: number): number {
  const started = Date.parse(session.startedAt);
  return Number.isFinite(started) ? Math.min(started, at) : at;
}

/** What the lane needs from the daemon. */
export interface GitLaneDeps {
  registry: Pick<SessionRegistry, "byUuid">;
  /** The asynchronous exec every git probe runs through. */
  execAsync: ExecAsync;
  now: () => number;
  /** The daemon's hook queue. Results are applied on it. */
  serial: { run<T>(task: () => Promise<T>): Promise<T> };
  /** SessionEnds waiting for their final read, by session uuid. */
  pendingSessionEnds: ReadonlyMap<
    string,
    HookEnvelope & { terminal?: unknown }
  >;
  /**
   * Record a pending SessionEnd's outcome and forget it. Called on the hook
   * queue, once the final read has been applied or cannot be made.
   */
  settleEnding: (ending: HookEnvelope, sessionUuid: string) => Promise<void>;
  /** Write sealed events to the WAL. Throws when the write fails. */
  record: (events: readonly TachoEvent[]) => void;
}

/** The lane's surface, as the daemon drives it. */
export interface GitLane {
  /** Ask for a read of one session's worktree on a later tick. */
  requestGitRead(
    harnessSessionId: string,
    want: { force: boolean; reconcile: boolean },
  ): void;
  /** Whether any session is waiting for a read. */
  hasPending(): boolean;
  /** Do the pending reads, then apply what they found. */
  drainGitReads(): Promise<void>;
}

export function createGitLane(deps: GitLaneDeps): GitLane {
  const {
    registry,
    execAsync,
    now,
    serial,
    pendingSessionEnds,
    settleEnding,
    record,
  } = deps;

  /**
   * Git facts per working directory, with the time they were read.
   *
   * The seam is here, in the daemon's git lane, rather than in
   * `contextFactsFromEnv` or
   * in the hook handler. `contextFactsFromEnv` is pure and reads environment
   * variables only; shelling out from it would put a process spawn inside a
   * normalizer that the transcript reader and the OTel path also call. The
   * hook handler runs on the serial queue that every wrapped agent on this
   * host waits on, and a hook has a decision budget measured in seconds. The
   * daemon already owns the `Exec` port, already knows each session's cwd,
   * and already has a place to hold state across frames, so it reads the
   * facts once per worktree and hands them to the recorder, which merges
   * them into the context block of every frame it seals afterwards.
   *
   * The cache is what keeps this off the per-frame path: a turn fires many
   * hooks, and the head sha does not move between them. Entries refresh at
   * turn boundaries and whenever one goes stale, so a commit made mid-session
   * is picked up without four `git` invocations per tool call.
   */
  const gitFactsByCwd = new Map<string, { at: number; facts?: GitFacts }>();
  const GIT_FACTS_TTL_MS = 30_000;

  async function gitFactsFor(
    cwd: string,
    force: boolean,
  ): Promise<GitFacts | undefined> {
    const cached = gitFactsByCwd.get(cwd);
    if (cached !== undefined && !force && now() - cached.at < GIT_FACTS_TTL_MS)
      return cached.facts;
    const facts = await readGitFacts(execAsync, cwd);
    gitFactsByCwd.set(cwd, {
      at: now(),
      ...(facts !== undefined ? { facts } : {}),
    });
    return facts;
  }

  /**
   * The git work one session is waiting for, by harness session id.
   *
   * A hook never reads a worktree. It records that one wants reading and
   * returns; the tick drains this map outside the serial queue. Two reasons.
   * A hook holds the queue that every wrapped agent on this host waits on,
   * and a prompt hook has a budget measured in seconds, so four `git`
   * invocations for one session times every live session was a way to spend
   * that budget on someone else's repository. And the read this seam now
   * also does, the worktree reconciliation, is heavier still: a whole-tree
   * `git status` plus a numstat. Neither belongs on the path a hook answers
   * on. Only the session the hook names is queued, never every live one.
   *
   * `force` skips the facts cache. `reconcile` asks for the observed change
   * list as well.
   */
  const gitPending = new Map<string, { force: boolean; reconcile: boolean }>();

  /** The most sessions one tick reads worktrees for. */
  const GIT_READS_PER_TICK = 4;

  /**
   * The least time between two worktree reconciliations of one session.
   *
   * The trigger is `Stop`, so the sampling rule is one reconciliation per
   * turn at most, and no more than one per this interval however short the
   * turns are. A burst of one-line turns therefore costs one whole-tree
   * `git status` every fifteen seconds rather than one per turn.
   */
  const RECONCILE_MIN_INTERVAL_MS = 15_000;
  const lastReconcileAt = new Map<string, number>();

  /**
   * When a throttled read may spawn its probes, by session uuid.
   *
   * A read the interval above turned down is put back rather than dropped, so
   * the observation it asked for is still made. Putting it back eligible
   * immediately meant the next control tick, a second later, ran the HEAD,
   * branch, status, and remote probes again and turned the reconciliation
   * down again: a session of short turns spent about sixty git processes on
   * one reconciliation (#3676). The read now waits here until the interval it
   * was turned down by has passed, and the tick passes over it until then.
   *
   * A session with a pending SessionEnd is never held: its final read is the
   * one the chain waits on, and the interval does not apply to it.
   */
  const gitReadEligibleAt = new Map<string, number>();

  function gitReadDue(sessionUuid: string): boolean {
    if (pendingSessionEnds.has(sessionUuid)) return true;
    const eligibleAt = gitReadEligibleAt.get(sessionUuid);
    return eligibleAt === undefined || now() >= eligibleAt;
  }

  function requestGitRead(
    harnessSessionId: string,
    want: { force: boolean; reconcile: boolean },
  ): void {
    const pending = gitPending.get(harnessSessionId);
    gitPending.set(harnessSessionId, {
      force: want.force || (pending?.force ?? false),
      reconcile: want.reconcile || (pending?.reconcile ?? false),
    });
  }

  /**
   * The git context of one worktree as a whole block, for `noteContext`.
   *
   * Every member is present, holding its value or undefined, because the
   * recorder merges what it is handed and drops the undefined ones. A
   * conditional spread would leave the last branch a session reported
   * standing on every later frame after the checkout went detached, which is
   * a stale fact stated as a current one. This is only ever called with the
   * result of a read that SUCCEEDED: a read that failed is not a report of a
   * detached head or a clean tree, it is no report at all, and it clears
   * nothing.
   */
  function gitContextOf(facts: GitFacts): Record<string, unknown> {
    return {
      git_head_sha: facts.head_sha,
      git_branch: facts.branch,
      git_dirty: facts.dirty,
      git_remote_digest: facts.remote_digest,
    };
  }

  /**
   * Do the pending git reads, then apply what they found.
   *
   * Called from the tick outside `serial.run`, so the spawns are not holding
   * the hook queue. Applying the results is in-memory work and goes back on
   * the queue, because sealing a frame moves a chain a hook may be moving
   * too.
   */
  async function drainGitReads(): Promise<void> {
    if (gitPending.size === 0) return;
    const work = [...gitPending.keys()]
      .filter(gitReadDue)
      .slice(0, GIT_READS_PER_TICK);
    if (work.length === 0) return;
    const found: Array<{
      session: SessionRecord;
      /**
       * The directory these facts were read from.
       *
       * The probes are asynchronous now, and a hook can move a session to
       * another repository while they run. `found` holds the mutable
       * `SessionRecord`, so without this the apply step would write one
       * repository's head and branch onto a session already working in
       * another, and could seal its reconciliation there too. The read is
       * discarded instead when the session has moved.
       */
      cwd: string;
      /** The directory the read started from, before resolving its root. */
      dir: string;
      ending?: HookEnvelope;
      // Absent for a repository with no commit yet, which has no HEAD to
      // describe but does have a worktree to reconcile.
      facts?: GitFacts;
      reading?: SessionChanges;
      snapshot?: WorktreeSnapshot;
    }> = [];
    for (const harnessSessionId of work) {
      const want = gitPending.get(harnessSessionId);
      gitPending.delete(harnessSessionId);
      gitReadEligibleAt.delete(harnessSessionId);
      if (want === undefined) continue;
      const session = registry.byUuid(harnessSessionId);
      const ending = pendingSessionEnds.get(harnessSessionId);
      // Where the agent last wrote, falling back to where it started.
      const dir = session?.workDir ?? session?.cwd;
      if (
        session === undefined ||
        session.sealed ||
        dir === undefined ||
        ending?.terminal !== undefined
      ) {
        if (ending !== undefined) {
          await serial.run(() => settleEnding(ending, harnessSessionId));
        }
        continue;
      }
      const at = now();
      const last = lastReconcileAt.get(harnessSessionId);
      const due =
        want.reconcile &&
        (ending !== undefined ||
          last === undefined ||
          at - last >= RECONCILE_MIN_INTERVAL_MS);
      // The throttle is read before the probes run, not after. A read whose
      // reconciliation is not due yet has nothing here worth four git
      // processes, so it is put back with the time it becomes eligible and
      // this tick spawns nothing for it. The git context it would also have
      // refreshed waits with it, inside the thirty seconds `gitFactsFor`
      // already treats as fresh.
      if (want.reconcile && !due) {
        gitReadEligibleAt.set(
          harnessSessionId,
          (last ?? at) + RECONCILE_MIN_INTERVAL_MS,
        );
        requestGitRead(harnessSessionId, { force: true, reconcile: true });
        continue;
      }
      if (due) lastReconcileAt.set(harnessSessionId, at);
      // Every read runs at the worktree root, so an edit in a subdirectory and
      // one at the top describe the same checkout, and the baseline is
      // switched only when the work moves to another root.
      const root = await readGitRoot(execAsync, dir);
      const cwd = root ?? dir;
      const facts = await gitFactsFor(cwd, want.force);
      // The session's first git read starts the clock its own commits are
      // measured from (see `readSessionChanges`). A session that already
      // holds a baseline was restored from a state file written before this
      // clock was kept, and keeps the old measure.
      if (session.gitFirstReadAt === undefined && !holdsBaseline(session))
        session.gitFirstReadAt = at;
      // The first read of each repository root records the uncommitted edits
      // already there, so a reconciliation can leave them out. Only in a
      // root: a directory in no repository has nothing to record, and a
      // status read there would fail on every hook.
      if (
        root !== undefined &&
        session.gitFirstReadAt !== undefined &&
        session.preexistingPaths?.[root] === undefined
      ) {
        const preexisting = await readPreexistingPaths(
          execAsync,
          root,
          startedAtOf(session, at),
        );
        if (preexisting !== undefined)
          session.preexistingPaths = rememberForRoot(
            session.preexistingPaths,
            root,
            preexisting,
          );
      }
      // Undefined means `rev-parse HEAD` did not answer, which covers a
      // directory that is not a repository AND a repository whose first
      // commit has not been made. The second is a real worktree full of real
      // creates, and `readWorkingTreeChanges` has its own fallback for an
      // absent HEAD, so the reconciliation still runs. Its own status read
      // is what tells the two apart: a non-repository answers nothing and
      // seals no frame. There is simply no git context to note for either.
      // The first read that answers in this worktree fixes the session's
      // baseline. Later reads find the session's own commits after it rather
      // than measuring from a `HEAD` those commits keep moving
      // (`readSessionChanges`). The baseline is held
      // per repository root: `rememberBaseline` puts back the one the
      // session holds for this root, so a `cd` inside one repository keeps
      // it and a move to another root captures that tree's HEAD, or finds
      // the one taken there before. A root with no baseline and no HEAD
      // leaves none in force, so this read never diffs against a commit in
      // another repository.
      rememberBaseline(session, cwd, facts?.head_sha);
      if (facts === undefined && !due) continue;
      found.push({
        session,
        dir,
        cwd,
        ending,
        facts,
        // A read that failed reports no changes rather than an empty list,
        // so no reconciliation frame is sealed for it. A frame saying the
        // worktree was clean is a claim, and nobody made the observation
        // behind it.
        ...(due
          ? await (async () => {
              const reading = await readSessionChanges(execAsync, cwd, {
                baseline: session.baselineCommit,
                firstReadAt: session.gitFirstReadAt,
                ownCommits: session.sessionCommits?.[cwd],
                preexisting: session.preexistingPaths?.[cwd],
              });
              return reading === undefined
                ? {}
                : {
                    reading,
                    snapshot: await readWorktreeSnapshot(
                      execAsync,
                      cwd,
                      session.baselineCommit,
                      reading.basis === "session"
                        ? reading.changes.map(
                            (change) => change.repo_relative_path,
                          )
                        : undefined,
                    ),
                  };
            })()
          : {}),
      });
    }
    if (found.length === 0) return;
    await serial.run(async () => {
      for (const {
        session,
        cwd,
        dir,
        facts,
        reading,
        snapshot,
        ending,
      } of found) {
        if (session.sealed) continue;
        // The session moved while the probe ran, so this answer describes a
        // repository it is no longer in. A later turn reads the new one.
        if ((session.workDir ?? session.cwd) !== dir) {
          if (ending !== undefined)
            requestGitRead(session.recorder.sessionUuid, {
              force: true,
              reconcile: true,
            });
          continue;
        }
        // The root rides with the git facts, so the run's checkout names the
        // worktree the facts came from rather than the directory the session
        // was started in.
        if (facts !== undefined)
          session.recorder.noteContext({
            ...gitContextOf(facts),
            worktree_path: cwd,
          });
        if (reading !== undefined) {
          recordReconciliation(session, reading, snapshot);
          if (
            reading.ownCommits.length > 0 ||
            session.sessionCommits?.[cwd] !== undefined
          )
            session.sessionCommits = rememberForRoot(
              session.sessionCommits,
              cwd,
              reading.ownCommits,
            );
        }
        if (
          ending !== undefined &&
          pendingSessionEnds.get(session.recorder.sessionUuid) === ending
        ) {
          await settleEnding(ending, session.recorder.sessionUuid);
        }
      }
    });
  }

  /**
   * Seal one session's reconciliation and write it, or leave that session's
   * chain exactly where the seal found it.
   *
   * Both halves matter, and both were wrong. The batch this used to write was
   * shared: every session the tick had reached handed its events to one
   * `record` call, so a write that threw for the session being settled took
   * the others' events with it, and no path retried them. And the seal that
   * computed them had already moved each chain's cursor, so the next
   * reconciliation sealed one position further on and the WAL kept a chain
   * with a hole in it.
   *
   * One session, one write, one mark. The mark names this recorder alone, so
   * the rollback cannot reach a sibling the loop has not settled yet. A
   * registry-wide snapshot would, by rebuilding every `SessionRecord` and
   * detaching the recorders this loop is still holding.
   */
  function recordReconciliation(
    session: SessionRecord,
    reading: SessionChanges,
    snapshot?: WorktreeSnapshot,
  ): void {
    const mark = session.recorder.markChain();
    try {
      record([
        session.recorder.sealCollectorEvent(
          "oxagen:worktree_reconciled",
          worktreeReconciledBody(reading.changes),
          {
            attrs: {
              // What the list measures, so a reader can tell a list that
              // leaves out pulled commits and earlier edits from one that
              // does not (ADR-186).
              changes_basis: reading.basis,
              pre_session_changes: PRE_SESSION_CHANGES[reading.preexisting],
              ...(snapshot
                ? {
                    worktree_root: snapshot.root,
                    ...(snapshot.repository
                      ? { repository_url: snapshot.repository }
                      : {}),
                    ...(snapshot.baseline
                      ? { diff_base_sha: snapshot.baseline }
                      : {}),
                    ...(snapshot.head ? { diff_head_sha: snapshot.head } : {}),
                    diff_complete: String(snapshot.complete),
                    diff_limitations: snapshot.limitations.join(","),
                  }
                : {}),
            },
            ...(snapshot
              ? { content: jsonContent(JSON.stringify(snapshot)) }
              : {}),
          },
        ),
      ]);
    } catch (error) {
      session.recorder.rollbackChain(mark);
      // The lane's own handler requeues the sessions with a pending end. This
      // one covers a session that is only reconciling, whose read was taken
      // off `gitPending` before the write was attempted.
      requestGitRead(session.recorder.sessionUuid, {
        force: true,
        reconcile: true,
      });
      throw error;
    }
  }

  return {
    requestGitRead,
    hasPending: () => gitPending.size > 0,
    drainGitReads,
  };
}
