/**
 * Deterministic JSON serialization with lexicographically sorted object keys.
 *
 * Two structurally-equal values always serialize to the same string regardless
 * of key insertion order. This is the canonical form used anywhere a stable,
 * order-independent digest of a value is required: content addressing (record
 * IDs), CRDT version digests, and OR-Set element identity.
 *
 * Array order is preserved (order is semantically meaningful in a list); only
 * object keys are sorted, recursively. `undefined` object properties are
 * omitted, matching `JSON.stringify`.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    sorted[key] = canonicalize(v);
  }
  return sorted;
}
