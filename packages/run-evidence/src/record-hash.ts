// record-hash.ts — the context record's `record_hash`, computed the way
// Stella computes it (stella-protocol/src/hash.rs, ADR 0004 there), so a file
// Oxagen writes into `.oxagen/rules/` re-verifies under `stella context
// validate` and a file Stella wrote re-verifies here.
//
// The preimage pipeline:
//   1. the record as a JSON object;
//   2. the top-level `record_hash` member removed (a record never hashes its
//      own hash);
//   3. every null-valued object member removed, recursively, so an explicit
//      null and an absent field hash identically. A null array element is not
//      a member and stays;
//   4. RFC 8785 (JCS) canonical bytes through `jcsBytes`;
//   5. sha256, lowercase hex, `sha256:` prefix.
//
// Step 3 is Stella's one divergence from the Context Graph Protocol's
// `record_hash_preimage` (which drops `record_hash` and canonicalizes, and
// normalizes no nulls); Oxagen adopts it so the protocol, Stella and Oxagen
// agree on every record that carries no explicit null (MC spec §9).
import { jcsBytes, sha256Digest, type Sha256Digest } from "./digest";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function stripNulls(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, member] of Object.entries(value)) {
      if (member === null) continue;
      out[key] = stripNulls(member);
    }
    return out;
  }
  return value;
}

/** The exact bytes that are hashed, as a UTF-8 string, for a test to pin. */
export function recordPreimage(record: Record<string, unknown>): string {
  const { record_hash: _dropped, ...rest } = record;
  void _dropped;
  const stripped = stripNulls(rest as JsonValue);
  return new TextDecoder().decode(jcsBytes(stripped));
}

/** `sha256:<64 lowercase hex>` over `recordPreimage(record)`. */
export function recordHash(record: Record<string, unknown>): Sha256Digest {
  return sha256Digest(new TextEncoder().encode(recordPreimage(record)));
}
