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
 * Domain separator for `digestUserEmail`.
 *
 * It rules out a collision with a hash of the same address computed elsewhere,
 * and with a generic precomputed table. It does NOT make the result one-way:
 * this string is public, so anyone holding the digest and a candidate address
 * can compute the same value and compare. See `digestUserEmail`.
 */
const USER_EMAIL_DIGEST_DOMAIN = "oxagen:tacho:user_email:v1\0";

/**
 * The PRE-IMAGE a collector sends in place of the address, so the address
 * itself never crosses the wire (#3072).
 *
 * This is not the value any store holds, and on its own it is not a safe thing
 * to store. An email address carries so little entropy that hashing one is not
 * a one-way function in practice: whoever holds the digest can guess
 * `someone@a-company-they-know.com`, hash it and compare. The domain prefix
 * above does not change that, because it is published — in this file, in
 * ADR-084, and in the migrations.
 *
 * What the control plane stores is an HMAC of this value under a key no host,
 * tenant or store reader holds
 * (`packages/handlers/src/lib/tacho-user-email-digest.ts`). Keying is what
 * makes it one-way for the reader the defect is about; hashing here is what
 * keeps the address off the wire. The two do different jobs and the second
 * does not substitute for the first.
 *
 * The address is lowercased and trimmed first so the same person reduces to
 * the same value whatever casing the harness reports, and so a legacy event
 * carrying the address reduces to what a current collector would have sent.
 * An empty or missing address yields `undefined`, never a digest of the empty
 * string.
 */
export function digestUserEmail(
  email: string | undefined | null,
): Sha256Digest | undefined {
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return digestBytes(`${USER_EMAIL_DIGEST_DOMAIN}${normalized}`);
}
