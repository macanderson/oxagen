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
}

/** Check, optionally sync, and decide. */
export async function evaluateGate(opts: GateOptions): Promise<GateDecision> {
  const { policy, readOnly = false } = opts;
  let verdict = await checkSteeringFreshness(opts);
  let sync: SyncResult | null = null;

  if (isStale(verdict) && autoSyncActive(policy) && !readOnly) {
    sync = await syncSteering({
      cwd: opts.cwd,
      verdict,
      run: opts.run,
      // A sync only ever refuses when it is not safe, so it is never forced
      // from the automatic path however the developer configured things.
      force: false,
    });
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
