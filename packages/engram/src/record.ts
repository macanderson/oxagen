/**
 * Record creation and content addressing.
 *
 * Every MemoryRecord gets a deterministic ID derived from its content via
 * blake3. Identical (kind + namespace + body) always produces the same ID,
 * giving us natural deduplication at the storage layer.
 */
import { createHash } from "blake3";
import type { MemoryRecord, Namespace, Provenance, RecordBody, RecordKind } from "./types";

/**
 * Compute a content-addressed record ID.
 *
 * The hash input is the canonical JSON serialization of { kind, namespace, body }.
 * This means:
 * - Same content in different namespaces → different ID (tenant isolation)
 * - Same content with different metadata (salience, provenance) → same ID (dedup)
 */
export function computeRecordId(
  kind: RecordKind,
  namespace: Namespace,
  body: RecordBody,
): string {
  const content = JSON.stringify({ kind, namespace, body });
  const hash = createHash();
  hash.update(content);
  return hash.digest("hex") as string;
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
  const id = computeRecordId(params.kind, params.namespace, params.body as RecordBody);
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
    createdAt: Date.now(),
  };
}

/**
 * Verify that a record's ID matches its content.
 * Useful for integrity checks on read-back from storage.
 */
export function verifyRecordIntegrity(record: MemoryRecord): boolean {
  const expectedId = computeRecordId(
    record.kind,
    record.namespace,
    record.body as RecordBody,
  );
  return record.id === expectedId;
}
