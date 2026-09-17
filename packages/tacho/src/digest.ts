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

/**
 * Domain separator for `digestUserEmail`. See that function for why it exists.
 */
const USER_EMAIL_DIGEST_DOMAIN = "oxagen:tacho:user_email:v1\0";

/**
 * The stable, non-reversible stand-in for a person's email address.
 *
 * An email address carries very little entropy: a bare `sha256(address)` is a
 * lookup away from the address itself, because anyone holding a list of
 * candidate addresses can digest each one and compare. Prefixing a fixed
 * domain string — the same shape `authorizationFingerprintBucketKey` uses in
 * `apps/api/src/middleware/distributed-rate-limit.ts` — means a digest written
 * here matches nothing a generic rainbow table or a digest computed anywhere
 * else in the platform would produce, while staying stable for one address so
 * distinct-person counts and per-person joins still work.
 *
 * The address is lowercased and trimmed first so the same person digests to
 * the same value whatever casing the harness reports. An empty or missing
 * address yields `undefined`, never a digest of the empty string.
 */
export function digestUserEmail(
  email: string | undefined | null,
): Sha256Digest | undefined {
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return digestBytes(`${USER_EMAIL_DIGEST_DOMAIN}${normalized}`);
}
