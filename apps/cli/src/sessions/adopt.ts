/**
 * adopt.ts — orphan auto-resume (ADR-023 + ADR-028).
 *
 * A session whose owning process died mid-run derives to `"orphaned"` at read
 * time (store.ts: dead pid + non-terminal state). Resuming one is already
 * possible manually — `oxagen fleet resume <sid> --turn N` forks a new session
 * that restores the tree at turn N and reconstructs history from the record —
 * but nothing does it automatically, so a crashed worker's work just sits there.
 *
 * {@link adoptOrphans} closes that gap: it scans the project's session roster,
 * finds the orphans, and forks each back to life through an injected `resume`
 * function (the integrator passes the existing fleet fork-resume machinery, so
 * this module stays free of the worktree/replay plumbing). Two properties keep
 * restarts safe:
 *
 *   1. Idempotency. An orphan that has ALREADY been resumed once is skipped, so
 *      running this on every launch never forks duplicates. The signal is on
 *      disk and needs no extra bookkeeping: a resumed session stamps
 *      `meta.resumeOf.sid` (ADR-028) pointing at its source, so "already
 *      adopted" is simply "some session names this orphan as its `resumeOf`".
 *      We treat a resume descendant in ANY state as proof of prior adoption
 *      (broader than just live/queued) — otherwise, once a resume COMPLETED, a
 *      later launch would see the still-orphaned source and fork it a second
 *      time. Chains walk forward: if a resume worker also died, ITS orphan is
 *      the new adoptable tip and the original stays skipped behind its child.
 *   2. A resume budget. At most `limit` (default 3) resume calls per invocation,
 *      and one orphan's failure never aborts the batch — it is recorded in
 *      `skipped` and the scan continues.
 *
 * KNOWN LIMITATION (intentional, this pass): fork-resume restores the tree at a
 * settled TURN boundary and reconstructs history to that point. The orphaned
 * worker's LAST, in-flight turn — the partial step it was on when it died — is
 * NOT recovered; the fork re-runs from the last settled turn instead. Mid-step
 * checkpointing is out of scope here and deliberately not attempted.
 */
import { debugLog } from "../lib/debug-log.js";
import { fleetRoot } from "./paths.js";
import { openFleetStore, type SessionStore } from "./store.js";

/** Provenance for one adopted orphan: the dead source and its fresh fork. */
export interface AdoptedOrphan {
  /** The orphaned session that was resumed. */
  sid: string;
  /** The new forked session now carrying the work forward. */
  newSid: string;
}

export interface AdoptOrphansOptions {
  /** Project directory whose fleet roster is scanned (resolves the fleet root). */
  cwd: string;
  /**
   * Fork a dead session back to life, returning the new session id. The
   * integrator supplies this — typically the existing `fleet resume` path
   * (restore the tree at the last settled turn, dispatch a detached fork).
   */
  resume: (sid: string) => Promise<string>;
  /** Max resume calls this invocation (default 3). Excess eligible orphans are skipped. */
  limit?: number;
  /** Injected store (tests). Defaults to the fleet store for `cwd`. */
  store?: SessionStore;
}

export interface AdoptOrphansResult {
  /** Orphans resumed this call, with their new fork ids. */
  adopted: AdoptedOrphan[];
  /** Orphans NOT resumed: already-adopted, over the resume budget, or a failed resume. */
  skipped: string[];
}

const DEFAULT_LIMIT = 3;

/**
 * Scan the project's fleet for orphaned sessions and fork each back to life
 * (up to `limit`), skipping any already resumed and any that fail. Never
 * throws for an individual orphan — a bad resume is recorded and the scan
 * continues.
 */
export async function adoptOrphans(
  opts: AdoptOrphansOptions,
): Promise<AdoptOrphansResult> {
  const store = opts.store ?? openFleetStore(fleetRoot(opts.cwd));
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  const sessions = await store.listSessions();

  // Every orphan that already has a resume descendant (any state) — proof it was
  // adopted before, so we must not fork it again.
  const alreadyResumed = new Set<string>();
  for (const s of sessions) {
    if (s.resumeOf) alreadyResumed.add(s.resumeOf.sid);
  }

  // listSessions() is newest-first; keep that order so the most recent crash is
  // recovered first when the budget is tight.
  const orphans = sessions.filter((s) => s.derivedState === "orphaned");

  const adopted: AdoptedOrphan[] = [];
  const skipped: string[] = [];
  let attempts = 0;

  for (const orphan of orphans) {
    if (alreadyResumed.has(orphan.sid)) {
      skipped.push(orphan.sid); // idempotent: a fork already exists
      continue;
    }
    if (attempts >= limit) {
      skipped.push(orphan.sid); // over the resume budget this call
      continue;
    }
    attempts += 1;
    try {
      const newSid = await opts.resume(orphan.sid);
      adopted.push({ sid: orphan.sid, newSid });
    } catch (err) {
      skipped.push(orphan.sid);
      void debugLog("error", "fleet.adopt-orphan-failed", {
        sid: orphan.sid,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { adopted, skipped };
}
