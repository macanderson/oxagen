/**
 * Episodic store interface.
 *
 * The hot path is append-only — records are written once and never mutated
 * during a turn. The ONLY sanctioned mutations are the offline consolidation
 * pipeline's (Phase D): reconciling salience/confidence from observed outcomes
 * and evicting TTL-expired records. Those live behind the explicit
 * `updateSalience` / `updateConfidence` / `evictExpired` methods below; nothing
 * on the read/write turn path calls them.
 */
import type { MemoryRecord, Namespace, RecordKind } from "../types";

/**
 * Query parameters for the episodic store.
 */
export interface EpisodicQuery {
  /** Required: scope to a specific namespace. */
  namespace: Namespace;
  /** Temporal filter: only records created after this timestamp. */
  after?: number;
  /** Temporal filter: only records created before this timestamp. */
  before?: number;
  /** Filter by record kinds. */
  kinds?: RecordKind[];
  /** Minimum salience threshold. */
  minSalience?: number;
  /** Maximum records to return. */
  limit: number;
  /** Pagination offset. */
  offset?: number;
}

/**
 * The episodic store contract. `DuckDBEpisodicStore` is the only shipped
 * implementation; the interface exists so a caller can substitute a fake in
 * tests or a different backing store later.
 */
export interface EpisodicStore {
  /** Append a single record. Deduplicates by ID (content address). */
  append(record: MemoryRecord): Promise<void>;

  /** Append a batch of records. Deduplicates by ID. */
  appendBatch(records: MemoryRecord[]): Promise<void>;

  /** Query records matching the given criteria. */
  query(opts: EpisodicQuery): Promise<MemoryRecord[]>;

  /** Retrieve a record by its content-addressed ID. Returns null if not found. */
  getById(id: string): Promise<MemoryRecord | null>;

  /** Retrieve multiple records by ID. Missing IDs are omitted from results. */
  getByIds(ids: string[]): Promise<MemoryRecord[]>;

  /** Get the most recent records in a namespace, optionally filtered by salience. */
  recent(
    namespace: Namespace,
    limit: number,
    minSalience?: number,
  ): Promise<MemoryRecord[]>;

  /**
   * Lexical/full-text search over record bodies. Scores each record by the
   * fraction of query tokens matched via a case-insensitive substring test
   * (0.0-1.0) — term-frequency recall for exact matches (error messages,
   * function names, file paths, stack traces) that vector similarity alone
   * misses. Backs `LexicalRetrievalEngine`'s injected `LexicalSearchFn`. The
   * DuckDB adapter implements it with `contains()` over the JSON body cast to
   * text.
   *
   * Scope note: only `namespace.org` and `namespace.workspace` are applied —
   * a session/agent-narrowed namespace still searches the whole workspace.
   */
  searchLexical(
    namespace: Namespace,
    query: string,
    limit: number,
  ): Promise<Array<{ recordId: string; score: number }>>;

  /**
   * Distinct namespaces (org + workspace) that have records in the store. Used
   * by the consolidation job to iterate every workspace with activity.
   */
  listNamespaces(): Promise<Namespace[]>;

  /**
   * Consolidation-only: set a record's salience in place. The id is unchanged
   * (salience is not part of the content hash). No-op if the id is absent.
   */
  updateSalience(id: string, salience: number): Promise<void>;

  /**
   * Consolidation-only: set a record's confidence in place (id unchanged).
   * No-op if the id is absent.
   */
  updateConfidence(id: string, confidence: number): Promise<void>;

  /**
   * Consolidation-only: evict records in `namespace` whose TTL has passed
   * (`ttl > 0 && ttl <= now`). Returns the number of records evicted.
   */
  evictExpired(namespace: Namespace, now: number): Promise<number>;

  /** Close the store connection and release resources. */
  close(): Promise<void>;
}
