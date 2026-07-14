import { createHash } from "node:crypto";

// Canonical JSON + content hashing for the storage manifest.
//
// Determinism is a hard requirement (ADR-031): the same inputs must always
// serialize to byte-identical text. JSON.stringify does NOT guarantee this —
// object key order follows insertion order, so two runs that build an object's
// keys in a different order produce different bytes. canonicalize() rewrites
// every plain object with its keys sorted lexicographically (recursively),
// giving a total, insertion-order-independent ordering. Arrays keep their
// order — array order is semantic and the generator is responsible for sorting
// arrays whose order is not meaningful (table lists, domain lists, etc.).

/**
 * Return a structural clone of `value` with every plain-object's keys sorted
 * lexicographically, recursively. Arrays are preserved in place (their order is
 * caller-controlled). Primitives pass through untouched.
 */
export function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) => canonicalize(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted as unknown as T;
  }
  return value;
}

/**
 * Serialize `value` to canonical JSON: keys sorted at every level, two-space
 * indented, trailing newline. Byte-identical across runs for identical input.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + "\n";
}

/**
 * Compute the sha256 content hash of a manifest BODY — i.e. the manifest with
 * its own `contentHash` field excluded (a hash cannot cover itself). The body
 * is canonicalized first, so the hash is a pure function of the manifest's
 * meaningful content and is stable across runs.
 */
export function contentHashOf(body: Record<string, unknown>): string {
  const { contentHash: _omit, ...rest } = body;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}
