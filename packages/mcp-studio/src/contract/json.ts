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
 */
export function plainJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : plainJson(item)));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = plainJson(item);
  }
  return out;
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
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * The text form of a lock file or any other generated JSON file: keys sorted
 * at every depth, two-space indent, and a final newline. The same value
 * always writes the same bytes.
 */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(plainJson(value)), null, 2)}\n`;
}
