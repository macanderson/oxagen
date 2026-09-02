/**
 * Canonical JSON serialization for content addressing.
 *
 * `JSON.stringify` preserves insertion order of object keys, so two objects
 * with identical content but different key order serialize to different
 * strings — and therefore hash to different record IDs. That silently breaks
 * content-addressed dedup: the same fact written by two code paths (or the
 * same object rebuilt after a round-trip through a store) can land as two
 * records.
 *
 * `canonicalStringify` produces a stable, key-sorted serialization so identical
 * content always yields identical bytes regardless of key order. It is the
 * single source of truth for any hash-input serialization in engram
 * (record IDs, OR-Set element identity).
 */

/**
 * Serialize a value to a canonical string with recursively sorted object keys.
 *
 * - Objects: keys sorted lexicographically, values recursively canonicalized.
 * - Arrays: order preserved (order is semantically meaningful).
 * - Primitives: JSON semantics (`undefined` inside objects is dropped, exactly
 *   as `JSON.stringify` does, so an absent key and an explicit `undefined` hash
 *   identically).
 *
 * Two deliberate departures from `JSON.stringify`, both of which matter when
 * the value came from an arbitrary tool payload:
 * - `toJSON()` is NOT honored. A `Date`, and any other class that relies on
 *   `toJSON`, serializes by its own enumerable keys — for a `Date` that is
 *   `{}`, so two different instants hash identically. Convert such values to a
 *   primitive (e.g. `date.getTime()`) before they reach a hashed body.
 * - Cycles are NOT detected. `JSON.stringify` throws a `TypeError` on a
 *   circular value; this recurses until the stack overflows.
 */
export function canonicalStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "number")
    return Number.isFinite(value as number) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify((value as bigint).toString());
  // undefined / function / symbol have no JSON representation on their own.
  if (t === "undefined" || t === "function" || t === "symbol") return "null";

  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeElement(v)).join(",")}]`;
  }

  // Plain object: sort keys, drop keys whose value is undefined/function/symbol
  // (matching JSON.stringify), recurse.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    const vt = typeof v;
    if (v === undefined || vt === "function" || vt === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${serialize(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Array elements serialize like object values under JSON.stringify: an
 * `undefined`/function/symbol element becomes `null` (not dropped), preserving
 * positional meaning.
 */
function serializeElement(value: unknown): string {
  const t = typeof value;
  if (value === undefined || t === "function" || t === "symbol") return "null";
  return serialize(value);
}
