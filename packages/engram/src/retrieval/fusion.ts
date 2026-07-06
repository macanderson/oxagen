/**
 * Reciprocal Rank Fusion — merges results from multiple retrieval engines
 * into a single ranked list.
 *
 * RRF formula: score(d) = Σ 1/(k + rank_i(d))
 * Then a weighted combination balancing relevance, recency, salience, and token efficiency.
 */
import type { RetrievalCandidate } from "./types";

/** Standard RRF constant. Higher k reduces the impact of rank differences. */
const RRF_K = 60;

/** Fusion weights — tuned by Phase D reinforcement learning. */
export interface FusionWeights {
  relevance: number; // RRF score contribution
  recency: number; // Recency decay boost
  salience: number; // Record salience boost
  outcome: number; // Outcome boost (success/failure events)
  tokenPenalty: number; // Penalty for expensive records
}

export const DEFAULT_WEIGHTS: FusionWeights = {
  relevance: 0.35,
  recency: 0.25,
  salience: 0.2,
  outcome: 0.1,
  tokenPenalty: 0.1,
};

const ONE_HOUR_MS = 3600000;
const RECENCY_LAMBDA = 0.1;

/**
 * Fuse candidates from multiple engines into a single ranked list.
 * Deduplicates by record ID (same record from multiple engines gets combined score).
 *
 * Recency has exactly ONE home: this function (ADR-021 §8 — deterministic
 * retrieval with a single, auditable scoring path). The temporal engine no
 * longer applies its own recency decay; it contributes rank only (salience
 * within the recent window), so recency is not double-counted here.
 *
 * @param topK Optional cap on the number of fused candidates returned. When
 *   omitted, all fused candidates are returned (previous behavior).
 */
export function fuseAndRank(
  engineResults: RetrievalCandidate[][],
  weights: FusionWeights = DEFAULT_WEIGHTS,
  topK?: number,
): RetrievalCandidate[] {
  // Step 1: Compute RRF scores across all engines
  const rrfScores = new Map<string, number>();
  const candidateMap = new Map<string, RetrievalCandidate>();

  for (const results of engineResults) {
    for (let rank = 0; rank < results.length; rank++) {
      const candidate = results[rank]!;
      const id = candidate.record.id;
      const rrfContribution = 1 / (RRF_K + rank + 1);
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + rrfContribution);

      // Keep the candidate with the highest individual score for metadata
      const existing = candidateMap.get(id);
      if (!existing || candidate.score > existing.score) {
        candidateMap.set(id, candidate);
      }
    }
  }

  // Step 2: Compute final weighted score for each unique candidate
  const now = Date.now();
  const fused: RetrievalCandidate[] = [];

  for (const [id, rrfScore] of rrfScores) {
    const candidate = candidateMap.get(id)!;
    const record = candidate.record;

    // Recency decay
    const ageHours = (now - Number(record.createdAt)) / ONE_HOUR_MS;
    const recencyScore = Math.exp(-RECENCY_LAMBDA * ageHours);

    // Outcome boost (episodic records with success/failure)
    const body = record.body as Record<string, unknown>;
    let outcomeBoost = 0;
    if (body.outcome === "failure") outcomeBoost = 0.3;
    else if (body.outcome === "success") outcomeBoost = 0.15;

    // Token cost penalty (normalized: assume max useful record is 500 tokens)
    const normalizedTokenCost = Math.min(1, candidate.tokenCost / 500);

    // Weighted combination. Kept as a RAW, unclamped score: clamping to [0,1]
    // (the old behavior) collapsed every candidate whose weighted sum went
    // negative — after the token penalty — to exactly 0, destroying their
    // relative order and creating spurious ties. The score is a *relative*
    // ranking signal; downstream (packer value-per-token, compression floor)
    // compares scores, so the absolute range is irrelevant and the sign is
    // meaningful information we must not throw away.
    const finalScore =
      weights.relevance * rrfScore * 10 + // Scale RRF (typically 0.01–0.05) to match others
      weights.recency * recencyScore +
      weights.salience * record.salience +
      weights.outcome * outcomeBoost -
      weights.tokenPenalty * normalizedTokenCost;

    fused.push({
      record,
      score: finalScore,
      source: candidate.source,
      tokenCost: candidate.tokenCost,
    });
  }

  // Step 3: Sort by raw final score descending, then apply the optional topK cap.
  fused.sort((a, b) => b.score - a.score);
  return typeof topK === "number" && topK >= 0 ? fused.slice(0, topK) : fused;
}
