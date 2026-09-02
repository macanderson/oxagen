/**
 * Migration logic: Neo4j AgentMemory → Engram episodic records.
 *
 * Reads existing memory nodes from Neo4j and emits them as content-addressed
 * Engram MemoryRecords. The migration is:
 * - Idempotent, with one exception: the ID is derived from the row's original
 *   `createdAt`, so re-running yields identical IDs — UNLESS `createdAt` is
 *   unparseable, in which case `parseCreatedAt` substitutes `Date.now()` and
 *   that row mints a new ID (and a new duplicate record) on every run.
 * - Additive: does NOT delete from Neo4j (dual-read period)
 * - Batch-oriented: processes one workspace at a time
 */
import { createRecord } from "../record";
import type { MemoryRecord } from "../types";
import type { EpisodicStore } from "../store/episodic";
import {
  type LegacyMemoryRow,
  mapKind,
  mapBody,
  mapNamespace,
  mapProvenance,
  WEIGHT_TO_SALIENCE,
  parseCreatedAt,
} from "./types";

export interface MigrationResult {
  /** Total legacy rows processed. */
  processed: number;
  /** Records actually written (new). */
  written: number;
  /** Records skipped (already existed — dedup by content address). */
  deduplicated: number;
  /** Rows that failed to convert (logged, not thrown). */
  errors: MigrationError[];
}

export interface MigrationError {
  legacyId: string;
  reason: string;
}

export interface MigrationOptions {
  /** Batch size for writing to the store. Default: 100. */
  batchSize?: number;
  /** Callback for progress reporting. */
  onProgress?: (processed: number, total: number) => void;
}

/**
 * Convert a legacy Neo4j MemoryRow into an Engram MemoryRecord.
 * Returns null if the row cannot be converted (logged as an error).
 */
export function convertLegacyRow(row: LegacyMemoryRow): MemoryRecord | null {
  if (!row.lesson || !row.orgId || !row.workspaceId) {
    return null;
  }

  const kind = mapKind(row.kind);
  const body = mapBody(row, kind);
  const namespace = mapNamespace(row);
  const provenance = mapProvenance(row);
  const salience = WEIGHT_TO_SALIENCE[row.weight] ?? 0.3;
  const confidence =
    typeof row.score === "number" ? Math.min(1, Math.max(0, row.score)) : 0.5;

  // Pass the original timestamp as createdAt so the content-addressed id is
  // derived from it (episodic records fold occurrence time into the id).
  // Overriding createdAt AFTER createRecord would leave the id computed from a
  // fresh monotonic time, making migration non-idempotent (re-running would
  // mint new ids and never dedupe).
  return createRecord({
    kind,
    namespace,
    body,
    salience,
    confidence,
    provenance,
    causality: [],
    createdAt: parseCreatedAt(row.createdAt),
  });
}

/**
 * Run the migration for a batch of legacy memory rows.
 *
 * This is the core migration function. It converts legacy rows and writes
 * them to the episodic store. The store's dedup (INSERT OR IGNORE / ReplacingMergeTree)
 * handles idempotency.
 */
export async function migrateMemories(
  rows: LegacyMemoryRow[],
  store: EpisodicStore,
  opts: MigrationOptions = {},
): Promise<MigrationResult> {
  const batchSize = opts.batchSize ?? 100;
  const result: MigrationResult = {
    processed: 0,
    written: 0,
    deduplicated: 0,
    errors: [],
  };

  const records: MemoryRecord[] = [];

  for (const row of rows) {
    result.processed++;

    try {
      const record = convertLegacyRow(row);
      if (!record) {
        result.errors.push({
          legacyId: row.id,
          reason: "Missing required fields (lesson, orgId, or workspaceId)",
        });
        continue;
      }

      // Check if already exists (content-addressed dedup)
      const existing = await store.getById(record.id);
      if (existing) {
        result.deduplicated++;
        continue;
      }

      records.push(record);

      // Flush batch when full
      if (records.length >= batchSize) {
        await store.appendBatch(records);
        result.written += records.length;
        records.length = 0;
      }
    } catch (err) {
      result.errors.push({
        legacyId: row.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    if (opts.onProgress) {
      opts.onProgress(result.processed, rows.length);
    }
  }

  // Flush remaining
  if (records.length > 0) {
    await store.appendBatch(records);
    result.written += records.length;
  }

  return result;
}
