/**
 * Record merge — CRDT merge semantics for memory records.
 *
 * When two offline nodes sync, their records are merged using these rules:
 * - Episodic: union (append-only, content-addressed → no duplicates)
 * - Semantic: OR-Set semantics (both retained on conflict)
 * - Procedural: OR-Set semantics
 * - Salience: PN-Counter merge (max per node)
 * - Causality: union of DAG edges
 */
import type { MemoryRecord } from "../types";

/**
 * Merge two sets of memory records from different nodes.
 * Returns the merged set with CRDT conflict resolution applied.
 */
export function mergeRecordSets(
  local: MemoryRecord[],
  remote: MemoryRecord[],
): MergeResult {
  const localMap = new Map(local.map((r) => [r.id, r]));
  const remoteMap = new Map(remote.map((r) => [r.id, r]));

  const merged: MemoryRecord[] = [];
  const conflicts: MergeConflict[] = [];
  const newFromRemote: string[] = [];

  // Records only in local → keep
  for (const record of local) {
    if (!remoteMap.has(record.id)) {
      merged.push(record);
    }
  }

  // Records only in remote → add (these are "new from remote")
  for (const record of remote) {
    if (!localMap.has(record.id)) {
      merged.push(record);
      newFromRemote.push(record.id);
    }
  }

  // Records in both → merge metadata (salience, confidence)
  for (const [id, localRecord] of localMap) {
    const remoteRecord = remoteMap.get(id);
    if (!remoteRecord) continue;

    // Content is identical (same content-addressed ID) — merge metadata
    const mergedRecord = mergeRecordMetadata(localRecord, remoteRecord);
    merged.push(mergedRecord.record);
    if (mergedRecord.conflict) {
      conflicts.push(mergedRecord.conflict);
    }
  }

  return { merged, conflicts, newFromRemote };
}

export interface MergeResult {
  /** Final merged record set. */
  merged: MemoryRecord[];
  /** Conflicts detected during merge (both versions retained). */
  conflicts: MergeConflict[];
  /** Record IDs that were new from the remote side. */
  newFromRemote: string[];
}

export interface MergeConflict {
  recordId: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolution: "max" | "local" | "remote" | "both";
}

/**
 * Merge metadata for two instances of the same record (same content-addressed ID).
 * Uses last-write-wins for timestamps, max for salience, and union for causality.
 */
function mergeRecordMetadata(
  local: MemoryRecord,
  remote: MemoryRecord,
): { record: MemoryRecord; conflict?: MergeConflict } {
  let conflict: MergeConflict | undefined;

  // Salience: take max (optimistic — highest importance wins)
  const salience = Math.max(local.salience, remote.salience);

  // Confidence: take max (most confident assertion wins)
  const confidence = Math.max(local.confidence, remote.confidence);

  // Causality: union of DAG edges
  const causality = [...new Set([...local.causality, ...remote.causality])];

  // If salience differs significantly, note a conflict
  if (Math.abs(local.salience - remote.salience) > 0.2) {
    conflict = {
      recordId: local.id,
      field: "salience",
      localValue: local.salience,
      remoteValue: remote.salience,
      resolution: "max",
    };
  }

  return {
    record: { ...local, salience, confidence, causality },
    conflict,
  };
}
