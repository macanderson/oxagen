/**
 * Lexical retrieval engine — BM25 full-text search over record bodies.
 *
 * Critical for exact matches that vector similarity misses: error messages,
 * function names, file paths, stack traces, identifiers.
 *
 * Uses DuckDB's built-in FTS extension (zero new dependencies).
 * For ClickHouse, uses tokenbf_v1 indexing.
 */
import type { EpisodicStore } from "../store/episodic";
import type {
  RetrievalCandidate,
  RetrievalEngine,
  RetrievalQuery,
} from "./types";
import { estimateTokens } from "./types";

/**
 * Full-text search function — injected so this engine works with both
 * DuckDB FTS and ClickHouse tokenbf adapters.
 */
export interface LexicalSearchFn {
  (
    query: string,
    opts: { orgId: string; workspaceId: string; limit: number },
  ): Promise<Array<{ recordId: string; score: number }>>;
}

export class LexicalRetrievalEngine implements RetrievalEngine {
  readonly name = "lexical";
  private store: EpisodicStore;
  private searchFn: LexicalSearchFn;

  constructor(store: EpisodicStore, searchFn: LexicalSearchFn) {
    this.store = store;
    this.searchFn = searchFn;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    if (!query.taskDescription) return [];

    // Extract search terms: use the task description as-is for BM25
    // DuckDB FTS handles tokenization internally
    const searchResults = await this.searchFn(query.taskDescription, {
      orgId: query.namespace.org,
      workspaceId: query.namespace.workspace,
      limit: query.limit,
    });

    if (searchResults.length === 0) return [];

    // Look up full records. getByIds returns storage order, not BM25 rank order,
    // so re-emit in the searchResults order (fusion reads array index as rank).
    const recordIds = searchResults.map((r) => r.recordId);
    const records = await this.store.getByIds(recordIds);
    const recordMap = new Map(records.map((r) => [r.id, r]));

    const scoreMap = new Map(searchResults.map((r) => [r.recordId, r.score]));

    const candidates: RetrievalCandidate[] = [];
    for (const id of recordIds) {
      const record = recordMap.get(id);
      if (!record) continue; // Drop misses
      candidates.push({
        record,
        score: Math.min(1, scoreMap.get(id) ?? 0),
        source: "lexical" as const,
        tokenCost: estimateTokens(record.body),
      });
    }
    return candidates;
  }
}
