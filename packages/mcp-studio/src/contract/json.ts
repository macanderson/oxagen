// json.ts: plain-JSON copies, canonical bytes, and the lock file's text form.
//
// The hashes in a lock file are SHA-256 over the RFC 8785 (JCS) form of a
// value. `@oxagen/run-evidence` computes JCS and refuses anything that is not
// plain JSON: an `undefined` value, a class instance, or an object without the
// ordinary prototype. Parsed TOML and zod output can carry all three, so every
// value is copied through `plainJson` before it is hashed.
import { digestJcs, jcsBytes, type Sha256Digest } from "@oxagen/run-evidence";

/**
 * A deep copy with ordinary prototypes and no `undefined` object values.
 * An `undefined` array item becomes null, as `JSON.stringify` writes it.
 *
 * Each copy is built with `Object.fromEntries`, which defines every key as an
 * own property. Assigning `out[key]` would send a key named `__proto__`,
 * which JSON allows, to the prototype setter instead.
 */
export function plainJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : plainJson(item)));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, plainJson(item)]),
  );
}

/** The RFC 8785 bytes of a value. */
export function canonicalBytes(value: unknown): Uint8Array {
  return jcsBytes(plainJson(value));
}

/** The RFC 8785 text of a value. */
export function canonicalText(value: unknown): string {
  return new TextDecoder().decode(canonicalBytes(value));
}

/** SHA-256 over the RFC 8785 form of a value, as `sha256:<hex>`. */
export function canonicalDigest(value: unknown): Sha256Digest {
  return digestJcs(plainJson(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}

/**
 * The text form of a lock file or any other generated JSON file: keys sorted
 * at every depth, two-space indent, and a final newline. The same value
 * always writes the same bytes.
 */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(plainJson(value)), null, 2)}\n`;
}
