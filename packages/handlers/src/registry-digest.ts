/**
 * registry-digest — canonical JSON + SHA-256 for the agent-asset registry.
 *
 * The immutability contract for tool_versions / context_record_versions /
 * context_promotions rows, mirroring skillBodyChecksum: a stored version can
 * later be proven byte-identical to what was published, and a promotion
 * ledger entry can be re-verified against its predecessor. Canonicalization
 * is recursive key-sorting (object key order must not change the digest);
 * arrays keep their order because order is meaning there.
 */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
