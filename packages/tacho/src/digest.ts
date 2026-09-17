import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

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
 */
export function jcs(value: JsonValue): string {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError("value has no JCS representation");
  }
  return text;
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
