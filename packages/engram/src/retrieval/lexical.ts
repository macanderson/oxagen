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
import type { RetrievalCandidate, RetrievalEngine, RetrievalQuery } from "./types";

/** Estimate token cost from body size. */
function estimateTokens(body: unknown): number {
  const str = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return Math.max(1, Math.ceil(str.length / 4));
}

/**
 * Full-text search function — injected so this engine works with both
 * DuckDB FTS and ClickHouse tokenbf adapters.
 */
export interface LexicalSearchFn {
  (query: string, opts: { orgId: string; workspaceId: string; limit: number }): Promise<
    Array<{ recordId: string; score: number }>
  >;
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

    // Look up full records
    const recordIds = searchResults.map((r) => r.recordId);
    const records = await this.store.getByIds(recordIds);

    const scoreMap = new Map(searchResults.map((r) => [r.recordId, r.score]));

    return records.map((record) => ({
      record,
      score: Math.min(1, scoreMap.get(record.id) ?? 0),
      source: "lexical" as const,
      tokenCost: estimateTokens(record.body),
    }));
  }
}
