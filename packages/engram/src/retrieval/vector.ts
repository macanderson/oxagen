/**
 * Vector retrieval engine — ANN similarity search over embedded memory records.
 *
 * Embeds the task description, then queries Neo4j's vector index for the
 * most semantically similar memories. Requires Track 0 (embedding pipeline)
 * to have run so records have embeddings.
 */
import type { EpisodicStore } from "../store/episodic";
import type { RetrievalCandidate, RetrievalEngine, RetrievalQuery } from "./types";

/** Estimate token cost from body size. */
function estimateTokens(body: unknown): number {
  const str = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return Math.max(1, Math.ceil(str.length / 4));
}

/**
 * Function that generates an embedding from text.
 * Injected so this module doesn't hard-depend on @oxagen/ai.
 */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * Function that queries the Neo4j vector index.
 * Returns recordId + cosine similarity score.
 */
export interface VectorQueryFn {
  (embedding: number[], opts: { orgId: string; workspaceId: string; limit: number }): Promise<
    Array<{ recordId: string; score: number }>
  >;
}

export class VectorRetrievalEngine implements RetrievalEngine {
  readonly name = "vector";
  private store: EpisodicStore;
  private embedFn: EmbedFn;
  private vectorQuery: VectorQueryFn;

  constructor(store: EpisodicStore, embedFn: EmbedFn, vectorQuery: VectorQueryFn) {
    this.store = store;
    this.embedFn = embedFn;
    this.vectorQuery = vectorQuery;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    if (!query.taskDescription) return [];

    // 1. Embed the task description
    const embedding = await this.embedFn(query.taskDescription);

    // 2. Query Neo4j vector index
    const vectorResults = await this.vectorQuery(embedding, {
      orgId: query.namespace.org,
      workspaceId: query.namespace.workspace,
      limit: query.limit,
    });

    if (vectorResults.length === 0) return [];

    // 3. Look up full records from the episodic store
    const recordIds = vectorResults.map((r) => r.recordId);
    const records = await this.store.getByIds(recordIds);

    // Build a score map for fast lookup
    const scoreMap = new Map(vectorResults.map((r) => [r.recordId, r.score]));

    return records.map((record) => ({
      record,
      score: Math.min(1, scoreMap.get(record.id) ?? 0),
      source: "vector" as const,
      tokenCost: estimateTokens(record.body),
    }));
  }
}
