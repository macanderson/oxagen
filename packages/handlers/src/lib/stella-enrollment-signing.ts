/**
 * The TypeScript half of Stella's enterprise enrollment signature.
 *
 * A managed Stella install accepts an org's telemetry enrollment only when the
 * HMAC over a canonical, domain-separated encoding of the claims verifies —
 * `canonical_enrollment_bytes` in stella's
 * `crates/stella-cli/src/enterprise_telemetry.rs`. Oxagen is the issuer, so
 * this module re-implements that encoding byte-for-byte. The two
 * implementations are tied by a shared conformance vector
 * (`fixtures/stella-enrollment-signature-conformance.v1.json`, vendored from
 * stella, which pins its own side with a test over the same file): change the
 * encoding in either tree and a committed test goes red in both.
 *
 * ## The encoding, exactly
 *
 * Domain prefix `stella.enterprise.telemetry.enrollment-signature.v1`, then a
 * sequence of length-framed fields — every frame is a 4-byte big-endian length
 * followed by the bytes. Scalars in declaration order; each list is framed
 * twice, first a frame holding the list length as 4 BE bytes (so the frame
 * reads length=4, then the count), then one frame per element; the two unix
 * timestamps are framed as 8-byte big-endian signed integers. The signature is
 * HMAC-SHA256 over those bytes, lowercase hex.
 */
import { createHmac } from "node:crypto";

export const ENROLLMENT_SIGNATURE_DOMAIN =
  "stella.enterprise.telemetry.enrollment-signature.v1";

export const ENROLLMENT_CLAIMS_SCHEMA =
  "stella.enterprise.telemetry.enrollment.v1";

export type StellaEnrollmentEventClass =
  | "execution_rollup"
  | "compliance_audit";

export interface StellaModelDimension {
  provider: string;
  model: string;
}

/**
 * The claims a signed enrollment carries — field-for-field stella's
 * `EnrollmentClaims` (serde `deny_unknown_fields`, so nothing extra may ride).
 */
export interface StellaEnrollmentClaims {
  schema: typeof ENROLLMENT_CLAIMS_SCHEMA;
  issuer: string;
  audience: string;
  enrollment_id: string;
  organization_id: string;
  workspace_id: string;
  endpoint: string;
  credential_env: string;
  event_classes: StellaEnrollmentEventClass[];
  host_data_isolation: "process_free";
  model_catalog: StellaModelDimension[];
  issued_at_unix_s: number;
  expires_at_unix_s: number;
}

function frame(chunks: Buffer[], value: Buffer): void {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  chunks.push(length, value);
}

function frameText(chunks: Buffer[], value: string): void {
  frame(chunks, Buffer.from(value, "utf8"));
}

/** A list's length rides as its own frame: 4 BE bytes of count, framed. */
function frameListLength(chunks: Buffer[], count: number): void {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(count);
  frame(chunks, bytes);
}

/** A unix timestamp rides as an 8-byte big-endian signed integer, framed. */
function frameUnixSeconds(chunks: Buffer[], seconds: number): void {
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`enrollment timestamp is not a safe integer: ${seconds}`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(BigInt(seconds));
  frame(chunks, bytes);
}

/** Stella's `canonical_enrollment_bytes`, byte-for-byte. */
export function canonicalEnrollmentBytes(
  claims: StellaEnrollmentClaims,
): Buffer {
  const chunks: Buffer[] = [Buffer.from(ENROLLMENT_SIGNATURE_DOMAIN, "utf8")];
  for (const scalar of [
    claims.schema,
    claims.issuer,
    claims.audience,
    claims.enrollment_id,
    claims.organization_id,
    claims.workspace_id,
    claims.endpoint,
    claims.credential_env,
  ]) {
    frameText(chunks, scalar);
  }
  frameListLength(chunks, claims.event_classes.length);
  for (const eventClass of claims.event_classes) {
    frameText(chunks, eventClass);
  }
  frameText(chunks, claims.host_data_isolation);
  frameListLength(chunks, claims.model_catalog.length);
  for (const dimension of claims.model_catalog) {
    frameText(chunks, dimension.provider);
    frameText(chunks, dimension.model);
  }
  frameUnixSeconds(chunks, claims.issued_at_unix_s);
  frameUnixSeconds(chunks, claims.expires_at_unix_s);
  return Buffer.concat(chunks);
}

/** HMAC-SHA256 over the canonical bytes, lowercase hex — `signature_hex`. */
export function signEnrollmentClaims(
  claims: StellaEnrollmentClaims,
  secretUtf8: string,
): string {
  return createHmac("sha256", Buffer.from(secretUtf8, "utf8"))
    .update(canonicalEnrollmentBytes(claims))
    .digest("hex");
}
