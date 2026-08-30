/**
 * Record merge — CRDT merge semantics for memory records.
 *
 * When two offline replicas sync, records that share a content-addressed ID
 * (same kind + namespace + body) can still carry divergent *metadata*. That
 * metadata is merged with these convergent, state-based rules:
 *
 * - Salience   — bounded max-register: `Math.max`. Salience is a [0,1]
 *   importance score, so max is a join over a totally-ordered bounded lattice
 *   (commutative, associative, idempotent → convergent). Concurrent boosts on
 *   different replicas collapse to the highest, which is the intended semantics
 *   for a bounded importance score. (The record schema stores salience as a
 *   scalar, not per-node counter state, so an additive PN-Counter is not
 *   representable without a schema change — out of scope for the sync layer.)
 * - Confidence — bounded max-register: `Math.max`, same reasoning.
 * - Causality  — grow-only set: union of DAG edges.
 *
 * The `versionDigest` below is derived from exactly these merge-relevant fields
 * so the Merkle layer detects metadata-only divergence between replicas that
 * share an ID set (see sync/merkle.ts).
 */
import type { MemoryRecord } from "../types";
import { canonicalStringify } from "../canonical-json";
import type { RecordVersion } from "./merkle";

/**
 * Digest of a record's mergeable metadata. Two replicas of the same record
 * (same ID) produce equal digests iff their salience, confidence, and causality
 * are identical; any divergence changes the digest and is surfaced by the
 * Merkle diff so the protocol reconciles it via `mergeRecordSets`.
 */
export function recordVersionDigest(record: MemoryRecord): string {
  return canonicalStringify({
    salience: record.salience,
    confidence: record.confidence,
    causality: [...record.causality].sort(),
  });
}

/** Pair a record with its version digest for Merkle-tree construction. */
export function toRecordVersion(record: MemoryRecord): RecordVersion {
  return { id: record.id, versionDigest: recordVersionDigest(record) };
}

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

  // Records in both → merge metadata (salience, confidence, causality)
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
 * Merge metadata for two instances of the same record (same content-addressed
 * ID). Bounded max-register for salience and confidence; grow-only set union
 * for causality. The result is independent of argument order (convergent).
 */
export function mergeRecordMetadata(
  local: MemoryRecord,
  remote: MemoryRecord,
): { record: MemoryRecord; conflict?: MergeConflict } {
  let conflict: MergeConflict | undefined;

  // Salience: bounded max-register (highest importance wins, order-independent).
  const salience = Math.max(local.salience, remote.salience);

  // Confidence: bounded max-register (most confident assertion wins).
  const confidence = Math.max(local.confidence, remote.confidence);

  // Causality: grow-only set — union of DAG edges (deterministically ordered).
  const causality = [
    ...new Set([...local.causality, ...remote.causality]),
  ].sort();

  // If salience differs significantly, note a conflict for observability.
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
