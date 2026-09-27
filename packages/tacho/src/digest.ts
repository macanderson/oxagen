import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** JSON values the wire can carry. Undefined members are dropped by JCS. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * RFC 8785 (JCS) canonical text of a JSON value, the same canonicalisation
 * CGP's conformance fixtures and `@oxagen/run-evidence` use, so a digest
 * computed here matches one computed on the control plane byte for byte.
 *
 * Written here rather than taken from `canonicalize@1.0.8`, which this used
 * before. That library wrote any object with a member named `toJSON` through
 * `JSON.stringify`, keys in insertion order, and everything inside it the
 * same way. A host can put that key in an event as an attribute name, and the
 * digest then depended on key order: a copy whose keys a store reordered no
 * longer hashed to its own hash, and `@oxagen/run-evidence` computed a
 * different digest for the same value (W-09). Here a `toJSON` member is data
 * like any other, and every other value is written exactly as before.
 *
 * A small serializer here, rather than another package: the rule is the one
 * above, the tests pin it against RFC 8785's example, and this package takes
 * no runtime dependency it does not need.
 *
 * ADR-041 asks each canonicalizer to name its trust boundary. Every caller
 * hands this JSON data: values parsed from JSON, or built as literals, and
 * an event is round-tripped through `JSON.stringify` before it is hashed
 * (`hashEvent`). A value that is not JSON data is outside `JsonValue`, and
 * this treats it as `canonicalize@1.0.8` did.
 */
export function jcs(value: JsonValue): string {
  const text = serialize(value, false);
  if (text === undefined) {
    throw new TypeError("value has no JCS representation");
  }
  return text;
}

/**
 * The text `canonicalize@1.0.8` wrote, for checking a hash a build before
 * `jcs` sealed. It differs from `jcs` only for a value that holds an object
 * with a `toJSON` member (see `hasToJsonMember`), and it depends on that
 * object's key order.
 */
export function legacyJcs(value: JsonValue): string {
  const text = serialize(value, true);
  if (text === undefined) {
    throw new TypeError("value has no JCS representation");
  }
  return text;
}

/**
 * Whether a JSON value holds, at any depth, an object with a member named
 * `toJSON` whose value is not null: the one case where `jcs` and
 * `legacyJcs` write different text.
 */
export function hasToJsonMember(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasToJsonMember);
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "toJSON") && record["toJSON"] != null) return true;
  return Object.values(record).some(hasToJsonMember);
}

/**
 * The walk `canonicalize@1.0.8` made, less its `toJSON` rule unless `legacy`
 * asks for it. Keys sort by UTF-16 code unit, which is what the default sort
 * compares. A member that is undefined or a symbol is left out of an object
 * and written as null in an array. Primitives, and an object whose `toJSON`
 * is a function (a `Date`, never JSON data), are written by `JSON.stringify`.
 */
function serialize(value: unknown, legacy: boolean): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function" || (legacy && toJson != null))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = "";
    value.forEach((item: unknown, index) => {
      const member =
        item === undefined || typeof item === "symbol" ? null : item;
      out += `${index === 0 ? "" : ","}${serialize(member, legacy)}`;
    });
    return `[${out}]`;
  }
  const record = value as Record<string, unknown>;
  let out = "";
  for (const key of Object.keys(record).sort()) {
    const member = record[key];
    if (member === undefined || typeof member === "symbol") continue;
    out += `${out.length === 0 ? "" : ","}${JSON.stringify(key)}:${serialize(member, legacy)}`;
  }
  return `{${out}}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `sha256:<64 lowercase hex>` over exact UTF-8 bytes of a string or raw bytes. */
export function digestBytes(input: string | Uint8Array): Sha256Digest {
  return `sha256:${sha256Hex(input)}`;
}

/** `sha256:<hex>` over the JCS canonical form of a JSON value. */
export function digestJcs(value: JsonValue): Sha256Digest {
  return digestBytes(jcs(value));
}

/** Size in UTF-8 bytes of the JSON text of a value, for the `*_bytes` columns. */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}
