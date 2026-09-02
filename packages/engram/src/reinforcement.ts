/**
 * Reinforcement — outcome-based feedback loop for memory salience.
 *
 * When a memory is retrieved by compile() and the turn succeeds, its salience
 * is boosted. When a memory is retrieved but the turn fails, it's slightly
 * penalized. Over time, useful memories float up and noise sinks down.
 */
import type { EpisodicStore } from "./store/episodic";

export interface ReinforcementStats {
  recordId: string;
  retrievalCount: number;
  successCount: number;
  failureCount: number;
  lastRetrievedAt: number;
  /**
   * The record's salience the first time apply anchored it. Adjustments are
   * computed from this stable base (never from the previous run's output), so
   * repeated application converges to a target instead of compounding.
   */
  baseSalience?: number;
  /**
   * Retrieval count already folded into the persisted salience at the last
   * apply (the checkpoint). Apply is a no-op while `retrievalCount` hasn't moved
   * past this, which makes re-running with no new events idempotent.
   */
  appliedRetrievalCount?: number;
}

/**
 * In-memory stats tracker. Nothing here is persisted: the map lives for the
 * lifetime of the tracker instance, so counts are lost on process exit and
 * grow without bound while the process runs (one entry per distinct record id
 * ever retrieved). A long-lived host should scope a tracker to a job and drop
 * it, or call {@link ReinforcementTracker.clear} between batches.
 */
export class ReinforcementTracker {
  private stats = new Map<string, ReinforcementStats>();

  /**
   * Record that a memory was retrieved during a compile() call.
   */
  recordRetrieval(recordId: string): void {
    const existing = this.stats.get(recordId) ?? {
      recordId,
      retrievalCount: 0,
      successCount: 0,
      failureCount: 0,
      lastRetrievedAt: 0,
    };
    existing.retrievalCount++;
    existing.lastRetrievedAt = Date.now();
    this.stats.set(recordId, existing);
  }

  /**
   * After a turn completes, reinforce all memories that were in the
   * context window based on the turn outcome.
   */
  reinforceTurn(retrievedIds: string[], outcome: "success" | "failure"): void {
    for (const id of retrievedIds) {
      const existing = this.stats.get(id) ?? {
        recordId: id,
        retrievalCount: 0,
        successCount: 0,
        failureCount: 0,
        lastRetrievedAt: 0,
      };
      if (outcome === "success") {
        existing.successCount++;
      } else {
        existing.failureCount++;
      }
      this.stats.set(id, existing);
    }
  }

  /**
   * Get stats for a record. Returns zero-counts if not tracked.
   */
  getStats(recordId: string): ReinforcementStats {
    return (
      this.stats.get(recordId) ?? {
        recordId,
        retrievalCount: 0,
        successCount: 0,
        failureCount: 0,
        lastRetrievedAt: 0,
      }
    );
  }

  /**
   * Get stats map for use with decay functions.
   */
  getStatsMap(): Map<string, { retrievals: number; successes: number }> {
    const map = new Map<string, { retrievals: number; successes: number }>();
    for (const [id, s] of this.stats) {
      map.set(id, { retrievals: s.retrievalCount, successes: s.successCount });
    }
    return map;
  }

  /**
   * Apply reinforcement by updating salience in the store.
   * Called periodically (e.g., by the consolidation job).
   *
   * Idempotent: the target salience is computed from a stable `baseSalience`
   * anchor plus the observed success rate, NOT by nudging the current
   * (already-adjusted) salience — so it converges to a target rather than
   * compounding to 1.0/0.01. After applying, the retrieval checkpoint advances,
   * so a re-run with no new events touches nothing.
   */
  async applyToStore(
    store: EpisodicStore,
    updateSalience: (recordId: string, newSalience: number) => Promise<void>,
  ): Promise<{ boosted: number; penalized: number }> {
    let boosted = 0;
    let penalized = 0;

    for (const [id, s] of this.stats) {
      // No new retrievals since the last apply → nothing to reconcile. This is
      // what makes a re-run a no-op.
      const appliedAt = s.appliedRetrievalCount ?? 0;
      if (s.retrievalCount <= appliedAt) continue;

      const record = await store.getById(id);
      if (!record) continue;

      // Anchor on the record's salience the first time we touch it, then always
      // compute from that anchor so the result is a function of the observed
      // outcomes, not of the previous run's output.
      const base = s.baseSalience ?? record.salience;
      s.baseSalience = base;

      const target = targetSalience(
        base,
        s.successCount,
        s.failureCount,
        s.retrievalCount,
      );

      if (target > base) boosted++;
      else if (target < base) penalized++;

      // Write first, then advance the checkpoint. Advancing before the write
      // would mean a rejected `updateSalience` permanently loses the
      // adjustment: the next run sees `retrievalCount <= appliedRetrievalCount`
      // and skips the record entirely, so the store keeps the stale salience
      // with nothing recording that the reconciliation never landed.
      if (target !== record.salience) {
        await updateSalience(id, target);
      }
      s.appliedRetrievalCount = s.retrievalCount;
      this.stats.set(id, s);
    }

    return { boosted, penalized };
  }

  /** Drop all tracked stats — also the way to bound the map in a long-lived host. */
  clear(): void {
    this.stats.clear();
  }
}

/**
 * Compute the reconciled target salience for a record from its stable base and
 * observed outcomes. Deterministic and bounded: the same stats always map to
 * the same target (so re-applying is a no-op), and the adjustment is capped so
 * repeated reinforcement can't saturate a record.
 *
 * successRate uses success/(success+failure) — the outcome fraction (M-2) — not
 * success/retrievalCount, which could exceed 1 when a memory is reinforced more
 * often than it is formally retrieved.
 */
export function targetSalience(
  base: number,
  successCount: number,
  failureCount: number,
  retrievalCount: number,
): number {
  const outcomes = successCount + failureCount;
  // No outcomes yet → neutral, so the fact keeps its base salience.
  const successRate = outcomes > 0 ? successCount / outcomes : 0.5;
  // More retrievals → more confidence in the signal → larger allowed swing,
  // capped at a full-weight adjustment of ±0.25 around the base.
  const sampleWeight = Math.min(1, retrievalCount / 10);
  const adjustment = (successRate - 0.5) * 0.5 * sampleWeight;
  const target = base + adjustment;
  return Math.min(1, Math.max(0.01, target));
}
