/**
 * Record creation and content addressing.
 *
 * Every MemoryRecord gets a deterministic ID derived from its content via
 * SHA-256 over a canonical (sorted-key) serialization. Identical
 * (kind + namespace + body) always produces the same ID for dedupable kinds
 * (semantic / procedural / entity / edge), giving natural dedup at the storage
 * layer.
 *
 * Episodic events are the exception: two identical events that genuinely
 * happened twice (e.g. a loop emitting the same tool_call) must be two records,
 * not one. So for kind="episodic" the record's occurrence time is folded into
 * the ID (see {@link computeRecordId}). A process-monotonic clock guarantees
 * distinct occurrence times even for back-to-back identical events.
 */
import { contentHash } from "./hash";
import { canonicalStringify } from "./canonical-json";
import type {
  MemoryRecord,
  Namespace,
  Provenance,
  RecordBody,
  RecordKind,
} from "./types";

/**
 * Process-monotonic millisecond clock. `Date.now()` can return the same value
 * for back-to-back calls; this never does, so each record gets a strictly
 * increasing `createdAt` — which, for episodic records, becomes the occurrence
 * discriminator that keeps identical events from aliasing to one ID.
 */
let lastTimestamp = 0;
function monotonicNow(): number {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return lastTimestamp;
}

/**
 * Compute a content-addressed record ID.
 *
 * The hash input is the canonical (sorted-key) JSON serialization of
 * { kind, namespace, body } — plus, for episodic records only, an `occurrence`
 * discriminator. This means:
 * - Same content in different namespaces → different ID (tenant isolation)
 * - Same content with different metadata (salience, provenance) → same ID
 *   (dedup) for semantic / procedural / entity / edge
 * - Identical episodic events at different occurrence times → different IDs
 *   (episodic events are facts-of-record, never deduped by content)
 *
 * Canonical serialization is required: `JSON.stringify` preserves key order, so
 * the same body built with different key order would otherwise hash differently.
 */
export function computeRecordId(
  kind: RecordKind,
  namespace: Namespace,
  body: RecordBody,
  occurrence?: number,
): string {
  const payload: Record<string, unknown> = { kind, namespace, body };
  if (kind === "episodic" && occurrence !== undefined) {
    payload["occurrence"] = occurrence;
  }
  return contentHash(canonicalStringify(payload));
}

/**
 * Parameters for creating a new MemoryRecord.
 * The `id` and `createdAt` are computed automatically.
 */
export interface CreateRecordParams {
  kind: RecordKind;
  namespace: Namespace;
  body: RecordBody;
  embedding?: Int8Array;
  salience: number;
  confidence: number;
  provenance: Provenance;
  causality?: string[];
  ttl?: number;
}

/**
 * Create a fully-formed MemoryRecord with content-addressed ID.
 *
 * This is the canonical way to produce a record — never construct
 * MemoryRecord literals directly; always go through createRecord()
 * to ensure the ID is consistent.
 */
export function createRecord(params: CreateRecordParams): MemoryRecord {
  // Occurrence time doubles as the episodic ID discriminator, so it must be
  // fixed before the ID is computed.
  const createdAt = monotonicNow();
  const id = computeRecordId(
    params.kind,
    params.namespace,
    params.body as RecordBody,
    createdAt,
  );
  return {
    id,
    kind: params.kind,
    namespace: params.namespace,
    body: params.body,
    embedding: params.embedding,
    salience: params.salience,
    confidence: params.confidence,
    provenance: params.provenance,
    causality: params.causality ?? [],
    ttl: params.ttl,
    createdAt,
  };
}

/**
 * Verify that a record's ID matches its content.
 * Useful for integrity checks on read-back from storage. For episodic records
 * the stored `createdAt` is the occurrence discriminator, so it participates in
 * the recomputed ID.
 */
export function verifyRecordIntegrity(record: MemoryRecord): boolean {
  const expectedId = computeRecordId(
    record.kind,
    record.namespace,
    record.body as RecordBody,
    record.createdAt,
  );
  return record.id === expectedId;
}
