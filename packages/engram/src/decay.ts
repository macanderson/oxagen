/**
 * Exponential value-based decay for memory salience.
 *
 * NOT pure time decay — frequently-used, outcome-positive memories resist
 * decay. Unused memories fade faster. Records below the minimum threshold
 * become eviction candidates (moved to cold tier, not deleted).
 *
 * That sentence used to be false. The clock ran from `createdAt` and nothing
 * reset it, so retrieval bought a capped CONSTANT rather than a delay:
 * `frequencyBoost` saturates at 1.1^10 ≈ 2.59 and `outcomeBoost` at
 * 1.3^5 ≈ 3.71, about 9.6x in total, against an exponential that halves every
 * seven days. A constant does not resist an exponential — it shifts the
 * crossing by a fixed offset and loses. Measured: a record retrieved a
 * thousand times with a hundred successful outcomes became an eviction
 * candidate 23 days later than one nobody ever touched, and at one year the
 * most valuable memory the system can describe sat fifteen orders of magnitude
 * below the floor (#1367).
 *
 * Two changes make the header true:
 *
 * - **Recency is in the exponent.** The half-life is measured from the most
 *   recent reinforcement, so a retrieval resets the clock. This is what
 *   `DecayConfig.halfLife` always claimed — "milliseconds until salience
 *   halves *with no retrievals*" — and there was no retrieval timestamp for it
 *   to measure from.
 * - **Reinforcement is a floor, not just a multiplier.** A record retrieved at
 *   least {@link DecayConfig.reinforcementThreshold} times is held at or above
 *   {@link DecayConfig.reinforcementFloor} while it is still within
 *   {@link DecayConfig.reinforcementFloorWindow} of its last reinforcement.
 *
 * That window is the deliberate answer to "what about a record that is heavily
 * used and genuinely stale": reinforcement holds a memory alive for as long as
 * it keeps being used, plus the window, and no longer. Past it the floor lapses
 * and the record decays from its last reinforcement like any other. The old
 * implicit answer was "54 days, regardless of use", which is the opposite
 * policy arrived at by accident.
 */
import type { MemoryRecord } from "./types";

/**
 * What decay needs to know about a record's use. `lastRetrievedAt` is optional
 * so a caller with only counts behaves exactly as before — but without it,
 * recency can only come from the record's durable `lastReinforcedAt`.
 */
export interface DecayStats {
  retrievals: number;
  successes: number;
  /** Unix ms of the most recent observed retrieval, if the caller tracks it. */
  lastRetrievedAt?: number;
}

export interface DecayConfig {
  /** Milliseconds until salience halves with no retrievals (default: 7 days). */
  halfLife: number;
  /** Below this effective salience, eligible for eviction (default: 0.05). */
  minSalience: number;
  /** Multiplier per retrieval (default: 1.1). */
  frequencyBoost: number;
  /** Multiplier per successful outcome (default: 1.3). */
  outcomeBoost: number;
  /**
   * Retrievals at or above which a record earns the reinforcement floor
   * (default: 3). Below it, a record is decayed on recency alone.
   */
  reinforcementThreshold: number;
  /**
   * How long after its last reinforcement the floor still applies
   * (default: 90 days). This is the stated cap on how long being used can hold
   * a memory alive once it stops being used.
   */
  reinforcementFloorWindow: number;
  /**
   * Effective salience a floored record cannot fall below (default: the
   * eviction threshold, so a reinforced record inside its window is never an
   * eviction candidate).
   */
  reinforcementFloor: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLife: 7 * 24 * 60 * 60 * 1000, // 7 days
  minSalience: 0.05,
  frequencyBoost: 1.1,
  outcomeBoost: 1.3,
  reinforcementThreshold: 3,
  reinforcementFloorWindow: 90 * 24 * 60 * 60 * 1000, // 90 days
  reinforcementFloor: 0.05,
};

/**
 * When a record was last reinforced: the newest of its durable
 * `lastReinforcedAt`, a live retrieval timestamp the caller observed, and its
 * creation time. Creation is the floor, so a record nothing has touched decays
 * exactly as it did before.
 */
export function lastReinforcedAt(
  record: MemoryRecord,
  observedLastRetrievedAt?: number,
): number {
  const createdAt = Number(record.createdAt);
  let anchor = Number.isFinite(createdAt) ? createdAt : 0;
  const durable = Number(record.lastReinforcedAt ?? 0);
  if (Number.isFinite(durable) && durable > anchor) anchor = durable;
  const observed = Number(observedLastRetrievedAt ?? 0);
  if (Number.isFinite(observed) && observed > anchor) anchor = observed;
  return anchor;
}

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
  /**
   * A retrieval the caller observed but has not written back yet (the
   * in-memory {@link ReinforcementStats.lastRetrievedAt}). Optional: the
   * durable `record.lastReinforcedAt` is used when it is absent.
   */
  observedLastRetrievedAt?: number,
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

  // The half-life runs from the last reinforcement, not from creation — that
  // is what makes a retrieval reset the clock rather than buy a constant.
  const anchor = lastReinforcedAt(record, observedLastRetrievedAt);
  // Clamp age to >= 0: an anchor in the future (clock skew, bad backfill)
  // would otherwise get timeDecay > 1 and inflate salience.
  const sinceReinforced = Math.max(0, now - anchor);
  const timeDecay = Math.pow(0.5, sinceReinforced / config.halfLife);
  const freqBoost = Math.pow(
    config.frequencyBoost,
    Math.min(retrievalCount, 10),
  );
  const outBoost = Math.pow(config.outcomeBoost, Math.min(successCount, 5));

  const effective = record.salience * timeDecay * freqBoost * outBoost;
  const bounded = Number.isFinite(effective) ? Math.min(1.0, effective) : 0;

  // A record that has actually been used is held above the eviction threshold
  // while it is still inside its reinforcement window. Past the window the
  // floor lapses, which is the stated policy for "heavily used, genuinely
  // stale" rather than an accident of the arithmetic.
  const floorApplies =
    retrievalCount >= config.reinforcementThreshold &&
    sinceReinforced <= config.reinforcementFloorWindow;
  if (floorApplies)
    return Math.min(1.0, Math.max(bounded, config.reinforcementFloor));
  return bounded;
}

/**
 * Identify records eligible for eviction (below minimum effective salience).
 * These move to cold tier — recoverable via engram.recall(), not deleted.
 */
export function identifyEvictionCandidates(
  records: MemoryRecord[],
  now: number,
  stats: Map<string, DecayStats>,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): MemoryRecord[] {
  return records.filter((r) => {
    const s = stats.get(r.id) ?? { retrievals: 0, successes: 0 };
    return (
      effectiveSalience(
        r,
        now,
        s.retrievals,
        s.successes,
        config,
        s.lastRetrievedAt,
      ) < config.minSalience
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
  stats: Map<string, DecayStats>,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const r of records) {
    const s = stats.get(r.id) ?? { retrievals: 0, successes: 0 };
    result.set(
      r.id,
      effectiveSalience(
        r,
        now,
        s.retrievals,
        s.successes,
        config,
        s.lastRetrievedAt,
      ),
    );
  }
  return result;
}
