/**
 * Temporal retrieval engine — recency-weighted recall from the episodic store.
 *
 * Scores records by exponential decay: recent events score higher.
 * Works immediately with the existing DuckDB/ClickHouse store — no new infra.
 */
import type { EpisodicStore } from "../store/episodic";
import type {
  RetrievalCandidate,
  RetrievalEngine,
  RetrievalQuery,
} from "./types";

/** Decay constant: λ = 0.1 → half-life ~7 hours. */
const LAMBDA = 0.1;
const ONE_HOUR_MS = 3600000;

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
    const now = Date.now();

    // Fetch recent records with minimum salience to skip noise
    const records = await this.store.query({
      namespace: query.namespace,
      minSalience: 0.2,
      limit: Math.min(query.limit * 2, 100), // Over-fetch then rank
    });

    // Score by recency decay * salience
    const scored: RetrievalCandidate[] = records.map((record) => {
      const ageHours = ((Number(record.createdAt) - now) / ONE_HOUR_MS) * -1;
      const recencyScore = Math.exp(-LAMBDA * Math.max(0, ageHours));
      const score = Math.min(1, record.salience * recencyScore);

      return {
        record,
        score,
        source: "temporal" as const,
        tokenCost: estimateTokens(record.body),
      };
    });

    // Sort by score descending and take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.limit);
  }
}
