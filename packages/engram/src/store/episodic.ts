/**
 * Episodic store interface.
 *
 * The store is append-only — records are never updated or deleted through
 * this interface. Eviction is handled by the consolidation pipeline (Phase D)
 * which operates at a higher level.
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
 * The episodic store contract. All adapters (DuckDB, ClickHouse) implement this.
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
  recent(namespace: Namespace, limit: number, minSalience?: number): Promise<MemoryRecord[]>;

  /** Close the store connection and release resources. */
  close(): Promise<void>;
}
