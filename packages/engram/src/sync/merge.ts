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
import type { MemoryRecord, Provenance } from "../types";
import { canonicalStringify } from "../canonical-json";
import { contentHash } from "../hash";
import type { RecordVersion } from "./merkle";

/**
 * Digest of everything about a record that two replicas can legitimately
 * disagree on.
 *
 * The content-addressed half — `id`, `kind`, `namespace`, `body` — is provably
 * identical for a given ID and is left out. Everything else is in, because a
 * field that can differ between peers and is not in the digest is a divergence
 * the protocol is structurally unable to notice: the Merkle diff reports the
 * two records as already in agreement and never asks `mergeRecordSets` to
 * reconcile them.
 *
 * It covered only salience, confidence and causality, so two records differing
 * in `provenance`, `createdAt`, `ttl` or `lastReinforcedAt` hashed identically
 * and stayed split forever (#1388).
 *
 * The result is hashed rather than returned raw. `embedding` is a quantized
 * vector, and a digest that carries it inline would grow every Merkle leaf by
 * the length of the vector; a fixed-width hash compares exactly the same way.
 * Note that this changes the digest of every record, so the first sync after
 * this lands reconciles the whole set once. That is a cost, not a fault: the
 * merge below is convergent, so it settles in one pass.
 */
export function recordVersionDigest(record: MemoryRecord): string {
  return contentHash(
    canonicalStringify({
      salience: record.salience,
      confidence: record.confidence,
      causality: [...record.causality].sort(),
      provenance: record.provenance,
      createdAt: record.createdAt,
      // Both optional. `null` rather than omission, so "absent" and "absent"
      // agree and "absent" and "present" do not.
      ttl: record.ttl ?? null,
      lastReinforcedAt: record.lastReinforcedAt ?? null,
      embedding: record.embedding ? Array.from(record.embedding) : null,
    }),
  );
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
 * The longer of two expiries, where absent means "never expires".
 *
 * `undefined` is the top of this lattice, not the bottom: a record with no
 * `ttl` outlives every record that has one. Taking the longest rather than the
 * shortest is a retention choice, stated here because #1388 asked for it to be
 * stated once — a memory the two peers disagree about is kept, because losing
 * one is the worse failure and eviction is a local policy that can run again.
 */
function longerTtl(a?: number, b?: number): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return Math.max(a, b);
}

/**
 * The more recent reinforcement, where absent means "never reinforced".
 *
 * Absent is the bottom here, the mirror of `longerTtl`: a retrieval that
 * happened on either peer really happened, so any timestamp beats none. This
 * field post-dates #1388 (it arrived with #1367) and is the one that decides
 * how fast a record decays, so leaving it unmerged would have aged the same
 * record differently on each peer — the exact consequence that issue describes
 * for `createdAt`.
 */
function laterReinforcement(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The provenance to keep when two peers authored the same content.
 *
 * Earliest `timestamp` wins, ties broken by the canonical encoding, which is a
 * total order — so the answer does not depend on which side is called `local`.
 *
 * Picking one is a real loss: content addressing means two agents genuinely
 * authored this record, and one of them stops being credited in a system whose
 * purpose is auditable memory. A grow-only set of contributors is the more
 * honest model, and ADR-044 records why it is not what shipped here — nothing
 * today reads a second contributor, and a field no reader consults is
 * scaffolding. The upgrade path is additive.
 */
function earlierProvenance(a: Provenance, b: Provenance): Provenance {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? a : b;
  return canonicalStringify(a) <= canonicalStringify(b) ? a : b;
}

/**
 * The embedding to keep. Present beats absent; two present vectors are ordered
 * by their canonical encoding.
 *
 * They can differ for one ID because the record hash covers kind, namespace and
 * body — not the model that embedded them — so two peers running different
 * embedding models produce different vectors for the same fact.
 */
function pickEmbedding(a?: Int8Array, b?: Int8Array): Int8Array | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const [as, bs] = [String(Array.from(a)), String(Array.from(b))];
  return as <= bs ? a : b;
}

/**
 * Merge metadata for two instances of the same record (same content-addressed
 * ID). The result is independent of argument order.
 *
 * That last sentence was already here and was not true. The function merged
 * three fields and took every other one from whichever record was passed as
 * `local`, so `merge(a, b)` and `merge(b, a)` disagreed on `provenance`,
 * `createdAt`, `ttl` and `lastReinforcedAt` — and `recordVersionDigest` could
 * not see any of them, so the Merkle diff called the two peers converged and
 * the split was permanent (#1388).
 *
 * Every field now has a rule, and every rule is a join on a lattice —
 * commutative, associative and idempotent — which is what makes the claim hold
 * rather than merely be repeated:
 *
 * - `salience`, `confidence` — bounded max-register. A [0,1] score, so max is a
 *   join over a totally-ordered bounded lattice, and concurrent boosts collapse
 *   to the highest.
 * - `causality` — grow-only set union.
 * - `createdAt` — min. The earliest observation is when the fact was first
 *   known; a later peer writing the same content did not create it again.
 * - `ttl` — longest, absent winning. See {@link longerTtl}.
 * - `lastReinforcedAt` — latest, absent losing. See {@link laterReinforcement}.
 * - `provenance` — earliest by timestamp, canonical tie-break. See
 *   {@link earlierProvenance}.
 * - `embedding` — present beats absent, canonical tie-break.
 *
 * `id`, `kind`, `namespace` and `body` are not merged because the ID is their
 * content hash: two records sharing an ID share all four by construction.
 */
export function mergeRecordMetadata(
  local: MemoryRecord,
  remote: MemoryRecord,
): { record: MemoryRecord; conflict?: MergeConflict } {
  let conflict: MergeConflict | undefined;

  const salience = Math.max(local.salience, remote.salience);
  const confidence = Math.max(local.confidence, remote.confidence);
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

  const ttl = longerTtl(local.ttl, remote.ttl);
  const lastReinforcedAt = laterReinforcement(
    local.lastReinforcedAt,
    remote.lastReinforcedAt,
  );
  const embedding = pickEmbedding(local.embedding, remote.embedding);

  // Spread `local` for the content-addressed fields it shares with `remote`,
  // then overwrite every mergeable one. Two optional fields are assigned
  // conditionally rather than set to `undefined`, so a merged record has the
  // same key set as an unmerged one and round-trips through the schema.
  const record: MemoryRecord = {
    ...local,
    salience,
    confidence,
    causality,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    provenance: earlierProvenance(local.provenance, remote.provenance),
  };
  if (ttl === undefined) delete record.ttl;
  else record.ttl = ttl;
  if (lastReinforcedAt === undefined) delete record.lastReinforcedAt;
  else record.lastReinforcedAt = lastReinforcedAt;
  if (embedding === undefined) delete record.embedding;
  else record.embedding = embedding;

  return { record, conflict };
}
