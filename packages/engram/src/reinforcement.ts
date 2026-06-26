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
}

/**
 * In-memory stats tracker. In production this would be persisted to
 * DuckDB/ClickHouse, but the interface is the same.
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
   */
  async applyToStore(
    store: EpisodicStore,
    updateSalience: (recordId: string, newSalience: number) => Promise<void>,
  ): Promise<{ boosted: number; penalized: number }> {
    let boosted = 0;
    let penalized = 0;

    for (const [id, s] of this.stats) {
      const record = await store.getById(id);
      if (!record) continue;

      const successRate =
        s.retrievalCount > 0 ? s.successCount / s.retrievalCount : 0;

      let newSalience = record.salience;
      if (successRate > 0.7 && s.retrievalCount >= 3) {
        // High success rate + enough samples → boost
        newSalience = Math.min(1.0, record.salience * 1.1);
        boosted++;
      } else if (successRate < 0.3 && s.retrievalCount >= 3) {
        // Low success rate + enough samples → penalize
        newSalience = Math.max(0.01, record.salience * 0.9);
        penalized++;
      }

      if (newSalience !== record.salience) {
        await updateSalience(id, newSalience);
      }
    }

    return { boosted, penalized };
  }

  /** Clear all stats (for tests). */
  clear(): void {
    this.stats.clear();
  }
}
