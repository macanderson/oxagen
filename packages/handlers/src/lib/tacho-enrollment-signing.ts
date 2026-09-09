/**
 * The signature over a Tacho host enrollment (spec section 5.2): the same
 * length-framed, domain-separated HMAC-SHA256 construction Stella's
 * enterprise enrollment uses (`stella-enrollment-signing.ts`), under its own
 * domain so a Stella document can never verify as a Tacho one or vice versa.
 *
 * The collector verifies this offline against the secret named by
 * `TACHO_ENROLLMENT_SIGNING_SECRET` in the managed-settings document, so a
 * forged enrollment is refused at the host rather than at the wire.
 *
 * Encoding: domain prefix, then one 4-byte big-endian-length frame per scalar
 * in declaration order; each list is framed twice (its count as 4 BE bytes,
 * then one frame per element); the two unix timestamps are framed as 8-byte
 * big-endian signed integers.
 */
import { createHmac } from "node:crypto";
import type { EnrollmentClaims } from "@oxagen/oxagen/tacho/schemas";

export const TACHO_ENROLLMENT_SIGNATURE_DOMAIN =
  "oxagen.tacho.host-enrollment-signature.v1";

function frame(chunks: Buffer[], value: Buffer): void {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  chunks.push(length, value);
}

function frameText(chunks: Buffer[], value: string): void {
  frame(chunks, Buffer.from(value, "utf8"));
}

function frameListLength(chunks: Buffer[], count: number): void {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(count);
  frame(chunks, bytes);
}

function frameUnixSeconds(chunks: Buffer[], seconds: number): void {
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`enrollment timestamp is not a safe integer: ${seconds}`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(BigInt(seconds));
  frame(chunks, bytes);
}

export function canonicalTachoEnrollmentBytes(
  claims: EnrollmentClaims,
): Buffer {
  const chunks: Buffer[] = [
    Buffer.from(TACHO_ENROLLMENT_SIGNATURE_DOMAIN, "utf8"),
  ];
  for (const scalar of [
    claims.schema,
    claims.issuer,
    claims.audience,
    claims.host_enrollment_id,
    claims.organization_id,
    claims.workspace_id,
    claims.agent_key,
    claims.ingest_endpoint,
    claims.bundle_endpoint,
    claims.commands_endpoint,
    claims.credential_env,
    claims.device_key_fingerprint,
  ]) {
    frameText(chunks, scalar);
  }
  frameListLength(chunks, claims.harnesses.length);
  for (const harness of claims.harnesses) {
    frameText(chunks, harness);
  }
  frameUnixSeconds(chunks, claims.issued_at_unix_s);
  frameUnixSeconds(chunks, claims.expires_at_unix_s);
  return Buffer.concat(chunks);
}

/** HMAC-SHA256 over the canonical bytes, lowercase hex. */
export function signTachoEnrollment(
  claims: EnrollmentClaims,
  secretUtf8: string,
): string {
  return createHmac("sha256", Buffer.from(secretUtf8, "utf8"))
    .update(canonicalTachoEnrollmentBytes(claims))
    .digest("hex");
}
