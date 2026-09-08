/**
 * Episodic store interface.
 *
 * The hot path is append-only — records are written once and never mutated
 * during a turn. The ONLY sanctioned mutations are the offline consolidation
 * pipeline's (Phase D): reconciling salience/confidence from observed outcomes
 * and evicting TTL-expired records. Those live behind the explicit
 * `updateSalience` / `updateConfidence` / `evictExpired` methods below; nothing
 * on the read/write turn path calls them.
 *
 * ## Phase D: the pass exists; the schedule is deferred, and why
 *
 * `runConsolidation` (`../consolidation/run`) is that pipeline, and it is
 * tested against this store. Nothing calls it on a timer, and that is recorded
 * here rather than fixed because there is currently nothing to attach a timer
 * to: **no code in this repository constructs an `EpisodicStore`.**
 *
 *     rg -na "createStore|DuckDBEpisodicStore" --glob '!packages/engram/**'
 *     # a changelog entry, a release note, and one comment in a shell script
 *
 * The CLI daemon that used to open one is gone, and every remaining import of
 * `@oxagen/engram` outside this package is a `import type`. A schedule added
 * today would be a caller with nothing to call it — the same shape as the
 * unreferenced maintenance functions #1418 was filed about, one level up.
 *
 * So the wiring a host owes is: construct a store, call `runConsolidation`
 * on a timer, and call `reinforce` when a turn ends with the ids `compile`
 * put in the window. The durable half of that is done — the counts and the
 * last-reinforcement time survive a restart, which the in-memory
 * `ReinforcementTracker` could never manage — so a host adds a schedule, not a
 * storage design.
 */
import type { DecayStats } from "../decay";
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
   *
   * `reinforcedAt` persists the record's last-reinforcement time alongside the
   * salience. Decay measures its half-life from that rather than from
   * `createdAt`, so without it a retrieval buys a capped constant against an
   * exponential instead of resetting the clock (#1367) — and the field was
   * unwritable, so that branch was dead in every deployment (#1418).
   */
  updateSalience(
    id: string,
    salience: number,
    reinforcedAt?: number,
  ): Promise<void>;

  /**
   * Record that these records were retrieved, and optionally how the turn that
   * used them went. Increments each record's durable retrieval count, its
   * success or failure count when an outcome is given, and stamps
   * `lastReinforcedAt`.
   *
   * Durable is the point. `ReinforcementTracker` keeps the same counts in a
   * `Map` that dies with the process, so a restart reset every memory's
   * observed usefulness to zero and decay ran as if nothing had ever been
   * retrieved (#1418).
   */
  reinforce(
    ids: string[],
    outcome: "success" | "failure" | null,
    at: number,
  ): Promise<void>;

  /**
   * The durable usage counts for every record in `namespace`, in the shape
   * decay wants. This is what lets a consolidation pass reconcile salience
   * from history rather than from whatever this process happens to remember.
   */
  readDecayStats(namespace: Namespace): Promise<Map<string, DecayStats>>;

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
