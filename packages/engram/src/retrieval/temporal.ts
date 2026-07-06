/**
 * Temporal retrieval engine — surfaces salient memories from the *recent*
 * window of the episodic store.
 *
 * Recency is used only to select the candidate window (the store returns the
 * most recent records), not to score them: recency has exactly one home, the
 * fusion stage (ADR-021 §8, R-3). Applying an exponential recency decay here
 * too would double-count it — the fuser already weights recency from
 * `createdAt`. So this engine ranks its window by salience and contributes
 * rank only; the fuser owns the recency magnitude.
 */
import type { EpisodicStore } from "../store/episodic";
import type {
  RetrievalCandidate,
  RetrievalEngine,
  RetrievalQuery,
} from "./types";

/** Estimate token cost from body size (rough: 1 token ≈ 4 chars). */
function estimateTokens(body: unknown): number {
  const str = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return Math.max(1, Math.ceil(str.length / 4));
}

export class TemporalRetrievalEngine implements RetrievalEngine {
  readonly name = "temporal";
  private store: EpisodicStore;

  constructor(store: EpisodicStore) {
    this.store = store;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    // Fetch the recent window (store.query orders by created_at DESC), filtering
    // low-salience noise. Recency is the *selection* mechanism here, not a score.
    const records = await this.store.query({
      namespace: query.namespace,
      minSalience: 0.2,
      limit: Math.min(query.limit * 2, 100), // Over-fetch then rank by salience
    });

    // Rank the recent window by salience. The fuser applies recency once, from
    // each record's createdAt, so this engine deliberately does not.
    const scored: RetrievalCandidate[] = records.map((record) => ({
      record,
      score: Math.min(1, record.salience),
      source: "temporal" as const,
      tokenCost: estimateTokens(record.body),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.limit);
  }
}
