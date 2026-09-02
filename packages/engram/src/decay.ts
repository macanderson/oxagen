/**
 * Exponential value-based decay for memory salience.
 *
 * NOT pure time decay — frequently-used, outcome-positive memories resist
 * decay. Unused memories fade faster. Records below the minimum threshold
 * become eviction candidates (moved to cold tier, not deleted).
 */
import type { MemoryRecord } from "./types";

export interface DecayConfig {
  /** Milliseconds until salience halves with no retrievals (default: 7 days). */
  halfLife: number;
  /** Below this effective salience, eligible for eviction (default: 0.05). */
  minSalience: number;
  /** Multiplier per retrieval (default: 1.1). */
  frequencyBoost: number;
  /** Multiplier per successful outcome (default: 1.3). */
  outcomeBoost: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLife: 7 * 24 * 60 * 60 * 1000, // 7 days
  minSalience: 0.05,
  frequencyBoost: 1.1,
  outcomeBoost: 1.3,
};

/**
 * Compute effective salience at a given time.
 *
 * salience(t) = base_salience * decay(t) * frequency_boost * outcome_boost
 *
 * Pinned records (salience=1.0) still decay but much slower due to the high base.
 */
export function effectiveSalience(
  record: MemoryRecord,
  now: number,
  retrievalCount: number,
  successCount: number,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const createdAt = Number(record.createdAt);
  // A record with a corrupt/missing createdAt (NaN, undefined) or a base
  // salience that isn't a finite number would otherwise propagate NaN through
  // every comparison — and `NaN < minSalience` is false, so a poisoned record
  // would never be evicted and would linger forever. Treat it as fully decayed
  // (minimum salience) so it's an eviction candidate instead.
  if (!Number.isFinite(createdAt) || !Number.isFinite(record.salience)) {
    return 0;
  }

  // Clamp age to >= 0: a record with a createdAt in the future (clock skew,
  // bad backfill) would otherwise get timeDecay > 1 and inflate salience.
  const age = Math.max(0, now - createdAt);
  const timeDecay = Math.pow(0.5, age / config.halfLife);
  const freqBoost = Math.pow(
    config.frequencyBoost,
    Math.min(retrievalCount, 10),
  );
  const outBoost = Math.pow(config.outcomeBoost, Math.min(successCount, 5));

  const effective = record.salience * timeDecay * freqBoost * outBoost;
  return Number.isFinite(effective) ? Math.min(1.0, effective) : 0;
}

/**
 * Identify records eligible for eviction (below minimum effective salience).
 * These move to cold tier — recoverable via engram.recall(), not deleted.
 */
export function identifyEvictionCandidates(
  records: MemoryRecord[],
  now: number,
  stats: Map<string, { retrievals: number; successes: number }>,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): MemoryRecord[] {
  return records.filter((r) => {
    const s = stats.get(r.id) ?? { retrievals: 0, successes: 0 };
    return (
      effectiveSalience(r, now, s.retrievals, s.successes, config) <
      config.minSalience
    );
  });
}

/**
 * Compute decayed salience for a batch of records.
 * Returns a map of recordId → effective salience.
 */
export function computeDecayedSaliences(
  records: MemoryRecord[],
  now: number,
  stats: Map<string, { retrievals: number; successes: number }>,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const r of records) {
    const s = stats.get(r.id) ?? { retrievals: 0, successes: 0 };
    result.set(
      r.id,
      effectiveSalience(r, now, s.retrievals, s.successes, config),
    );
  }
  return result;
}
