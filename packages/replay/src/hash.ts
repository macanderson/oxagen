/**
 * Deterministic hashing for the record store (ADR-028).
 *
 * Blob refs are `sha256(content)`, and record payloads are serialized with a
 * stable key order so the same logical value always produces the same ref —
 * that is what makes dedup free and integrity checkable.
 */
import { createHash } from "node:crypto";

/** Hex sha256 of a UTF-8 string. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * JSON.stringify with objects' keys sorted at every depth, so two structurally
 * equal values serialize identically regardless of insertion order. Arrays
 * keep their order (order is meaning there). Non-JSON values (undefined,
 * functions) follow JSON.stringify semantics.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeysDeep(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * JSON-stringify an arbitrary runtime value for recording, tolerant of cycles
 * and exotic objects — recording must never throw into the run it observes.
 */
export function safeStableStringify(value: unknown): string {
  try {
    const json = stableStringify(value);
    return json ?? String(value);
  } catch {
    try {
      return JSON.stringify(String(value));
    } catch {
      return '"<unserializable>"';
    }
  }
}
