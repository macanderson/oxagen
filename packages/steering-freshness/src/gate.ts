/**
 * gate.ts — one decision, made once, for every harness.
 *
 * ## Why this is not in the harness adapters
 *
 * Oxagen governs whatever agent a team already runs: Claude Code, Codex, a
 * custom loop, anything that can shell out. Each of those intercepts a
 * prompt differently — different config file, different hook event,
 * different way of saying "stop". If the *decision* lived in the adapters,
 * every harness would grow its own slightly-wrong copy of "is this stale,
 * and does that matter here", they would drift, and a customer's blocking
 * policy would mean something different depending on which agent they
 * happened to open.
 *
 * So: the decision is computed here, once, and an adapter is only allowed to
 * render it. Adding a harness is a renderer and nothing else — which is the
 * property that has to hold for as long as new agents keep appearing.
 *
 * ## Why auto-sync runs inside the gate
 *
 * The two switches are one behaviour: the point of auto-sync is that the
 * blocking one rarely fires. Running the sync somewhere else would leave a
 * window where the gate blocks a prompt that the sync was about to fix, and
 * the developer would see a refusal for a problem that no longer exists.
 */
import {
  checkSteeringFreshness,
  isStale,
  type CheckOptions,
  type FreshnessVerdict,
} from "./check";
import { autoSyncActive, blockingActive, type SteeringPolicy } from "./policy";
import { syncSteering, type SyncResult } from "./sync";

export type GateAction = "allow" | "warn" | "block";

export interface GateDecision {
  action: GateAction;
  verdict: FreshnessVerdict;
  policy: SteeringPolicy;
  /** The auto-sync attempt, when the policy asked for one. */
  sync: SyncResult | null;
  /**
   * Process exit status for adapters that signal by exit code.
   * 0 allows (a warning still allows); 2 blocks — the value every harness
   * checked treats as "the hook refused", rather than a generic failure.
   */
  exitCode: 0 | 2;
}

export interface GateOptions extends CheckOptions {
  /** Skip the sync even when the policy enables it (`steering status`). */
  readOnly?: boolean;
  /**
   * Read the gates the production branch commits again, and fold them again.
   *
   * Those gates are read from a remote-tracking ref, and the check below is
   * what moves that ref. So a production branch that had just committed
   * `blockStaleRuns: true` alongside the records this checkout is missing was
   * read at its old value: the same invocation went on to find the newly
   * fetched records behind, kept the `false` it had already resolved, and
   * only warned. Enforcement started one prompt late, on exactly the prompt
   * the new records were published to govern.
   *
   * Called only when the check contacted the remote, so the common path,
   * where the ref cannot have moved, pays nothing. The answer may only
   * tighten the two gates; see {@link tightenedBy}.
   */
  reloadPolicy?: () => Promise<SteeringPolicy>;
}

/**
 * `before`, with either gate the reload switched on switched on as well.
 *
 * A reload may tighten and nothing else. The scalars stay as they were,
 * because the ref the check compared against and the paths it excluded were
 * settled before it ran, and swapping them in afterwards would judge a
 * verdict against a question it was never asked. Loosening is refused for the
 * reason the whole fold is a ratchet: a gate one scope switched on is not a
 * later read's to switch off.
 */
function tightenedBy(
  before: SteeringPolicy,
  after: SteeringPolicy,
): SteeringPolicy {
  const autoSync = before.autoSync || after.autoSync;
  const blockStaleRuns = before.blockStaleRuns || after.blockStaleRuns;
  if (autoSync === before.autoSync && blockStaleRuns === before.blockStaleRuns)
    return before;
  return {
    ...before,
    autoSync,
    blockStaleRuns,
    sources: {
      autoSync: before.autoSync
        ? before.sources.autoSync
        : after.sources.autoSync,
      blockStaleRuns: before.blockStaleRuns
        ? before.sources.blockStaleRuns
        : after.sources.blockStaleRuns,
    },
  };
}

/** Check, optionally sync, and decide. */
export async function evaluateGate(opts: GateOptions): Promise<GateDecision> {
  const { readOnly = false, reloadPolicy } = opts;
  let policy = opts.policy;
  let verdict = await checkSteeringFreshness(opts);
  let sync: SyncResult | null = null;

  // The check has just fetched, so the ref the committed gates are read from
  // may have moved since this invocation resolved its policy. Ask again,
  // while the decision is still ahead of us and before the sync reads
  // `autoSync`.
  //
  // Three conditions, so the prompt path pays for this only when it can
  // change the answer. A fetch that failed moved nothing and a throttled one
  // never contacted the remote. A checkout that is current is allowed
  // whatever the gates say, which is also why an `allow` decision may carry
  // gates one publication old: nothing reads them.
  if (
    isStale(verdict) &&
    reloadPolicy &&
    verdict.fetch.attempted &&
    verdict.fetch.ok
  ) {
    try {
      policy = tightenedBy(policy, await reloadPolicy());
    } catch {
      // A reload that throws has told us nothing, so the policy the gate
      // already resolved stands. Letting the rejection escape would reach the
      // CLI's catch-all, which exits 0, and a read that only ever tightens
      // would have become a way to skip a gate that was already on.
    }
  }

  if (isStale(verdict) && autoSyncActive(policy) && !readOnly) {
    try {
      sync = await syncSteering({
        cwd: opts.cwd,
        verdict,
        run: opts.run,
        // A sync only ever refuses when it is not safe, so it is never forced
        // from the automatic path however the developer configured things.
        force: false,
      });
    } catch (error) {
      // A sync that throws (a locked index, a permission error, a `restore`
      // that failed) is a sync that did not happen. Letting the rejection
      // escape reached the CLI's catch-all, which exits 0, so turning
      // `autoSync` on let a checkout known to be stale walk past
      // `blockStaleRuns`. The verdict was already decided and stands; the
      // failure is reported as a refusal so the banner can say what happened.
      sync = {
        applied: false,
        refusal: "unknown_state",
        message: `Auto-sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        updated: [],
        removed: [],
        fromCommit: null,
        committed: false,
      };
    }
    if (sync.applied) {
      // Re-ask rather than assume. The sync wrote files; the cheapest way to
      // be sure the gate is judging the post-sync state is to look at it,
      // and the remote was already fetched, so this costs no network.
      verdict = await checkSteeringFreshness(opts);
    }
  }

  if (!isStale(verdict)) {
    return { action: "allow", verdict, policy, sync, exitCode: 0 };
  }
  if (blockingActive(policy)) {
    return { action: "block", verdict, policy, sync, exitCode: 2 };
  }
  return { action: "warn", verdict, policy, sync, exitCode: 0 };
}
