/**
 * Lexical retrieval engine — exact-term search over record bodies.
 *
 * Critical for exact matches that vector similarity misses: error messages,
 * function names, file paths, stack traces, identifiers.
 *
 * The engine itself is backend-agnostic: it takes an injected
 * {@link LexicalSearchFn} and only re-orders and hydrates whatever that
 * function returns. The one shipped implementation is
 * `DuckDBEpisodicStore.searchLexical`, which scores each record by the
 * fraction of query terms it contains (see `store/lexical-tokenize.ts`).
 * It is term-frequency recall, not BM25 — there is no length normalization
 * and no inverse-document-frequency weighting.
 */
import type { EpisodicStore } from "../store/episodic";
import type {
  RetrievalCandidate,
  RetrievalEngine,
  RetrievalQuery,
} from "./types";
import { estimateTokens } from "./types";

/**
 * Full-text search function — injected so this engine is not bound to any one
 * store adapter. Returns record IDs with a 0.0–1.0 relevance score, best first.
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

    // Look up full records. getByIds returns storage order, not relevance order,
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
