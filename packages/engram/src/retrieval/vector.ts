/**
 * Vector retrieval engine — ANN similarity search over embedded memory records.
 *
 * Embeds the task description, then queries Neo4j's vector index for the
 * most semantically similar memories. Requires Track 0 (embedding pipeline)
 * to have run so records have embeddings.
 */
import type { EpisodicStore } from "../store/episodic";
import type {
  RetrievalCandidate,
  RetrievalEngine,
  RetrievalQuery,
} from "./types";
import { estimateTokens } from "./types";

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
  (
    embedding: number[],
    opts: { orgId: string; workspaceId: string; limit: number },
  ): Promise<Array<{ recordId: string; score: number }>>;
}

export class VectorRetrievalEngine implements RetrievalEngine {
  readonly name = "vector";
  private store: EpisodicStore;
  private embedFn: EmbedFn;
  private vectorQuery: VectorQueryFn;

  constructor(
    store: EpisodicStore,
    embedFn: EmbedFn,
    vectorQuery: VectorQueryFn,
  ) {
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

    // 3. Look up full records from the episodic store. getByIds does not
    //    preserve the id-list order (it's a `WHERE id IN (...)` with no ORDER
    //    BY), so re-emit in the ANN score order — otherwise fusion, which reads
    //    array index as the RRF rank, would rank on arbitrary storage order.
    const recordIds = vectorResults.map((r) => r.recordId);
    const records = await this.store.getByIds(recordIds);
    const recordMap = new Map(records.map((r) => [r.id, r]));

    const scoreMap = new Map(vectorResults.map((r) => [r.recordId, r.score]));

    const candidates: RetrievalCandidate[] = [];
    for (const id of recordIds) {
      const record = recordMap.get(id);
      if (!record) continue; // Drop misses (record evicted/not yet materialized)
      candidates.push({
        record,
        score: Math.min(1, scoreMap.get(id) ?? 0),
        source: "vector" as const,
        tokenCost: estimateTokens(record.body),
      });
    }
    return candidates;
  }
}
