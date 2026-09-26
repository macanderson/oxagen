/**
 * The run attestation (Mission Control spec §8.3): an Ed25519 signature by
 * the attester key over the RFC 8785 canonical JSON of the seal figures
 * `(run_id, attempt_id, frame_count, merkle_root, archive_segment_digest,
 * enforcement_tier, completeness_gaps)`, plus the replay grade the seal
 * recorded. The key id is the digest of the public key (the same rule the
 * policy bundle uses), so rotation is visible by name and an export carries
 * the key that verifies it.
 *
 * Pure: the deployment's key comes from the caller. The verifier script an
 * export ships reimplements `verifyAttestation` with `node:crypto` alone.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { jcs, type JsonValue } from "../digest";
import { keyIdForPublicKey } from "../host/key-id";

export interface AttestationPayload {
  run_id: string;
  attempt_id: string;
  frame_count: number;
  merkle_root: string;
  archive_segment_digest: string;
  enforcement_tier: string;
  completeness_gaps: string[];
  replay_grade: string | null;
}

/**
 * The payload fields a run attestation signs over, in payload order (#4000).
 * A reader names them beside the signature, because a seal carries the values
 * and the attestation carries only the field names.
 */
export const RUN_ATTESTATION_FIELDS = [
  "run_id",
  "attempt_id",
  "frame_count",
  "merkle_root",
  "archive_segment_digest",
  "enforcement_tier",
  "completeness_gaps",
  "replay_grade",
] as const satisfies readonly (keyof AttestationPayload)[];

/**
 * Fails to compile when `AttestationPayload` gains a field the list above
 * does not name, so the names a reader prints cannot fall behind what is
 * signed.
 */
type UnlistedAttestationField = Exclude<
  keyof AttestationPayload,
  (typeof RUN_ATTESTATION_FIELDS)[number]
>;
const everyAttestationFieldListed: [UnlistedAttestationField] extends [never]
  ? true
  : never = true;
void everyAttestationFieldListed;

export interface Attestation {
  payload: AttestationPayload;
  key_id: string;
  alg: "ed25519";
  /** base64 over the JCS bytes of `payload`. */
  sig: string;
}

export interface AttesterKey {
  keyId: string;
  publicKeyPem: string;
  privateKey: KeyObject;
}

/** The attester key from its PKCS#8 PEM; refuses anything but Ed25519. */
export function attesterKeyFromPem(privateKeyPem: string): AttesterKey {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `attester key must be ed25519, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return { keyId: keyIdForPublicKey(publicKeyPem), publicKeyPem, privateKey };
}

function attestationBytes(payload: AttestationPayload): Buffer {
  return Buffer.from(jcs(payload as unknown as JsonValue), "utf8");
}

export function signAttestation(
  payload: AttestationPayload,
  key: AttesterKey,
): Attestation {
  return {
    payload,
    key_id: key.keyId,
    alg: "ed25519",
    sig: sign(null, attestationBytes(payload), key.privateKey).toString(
      "base64",
    ),
  };
}

export function verifyAttestation(
  attestation: Attestation,
  publicKeyPem: string,
): boolean {
  if (attestation.alg !== "ed25519") return false;
  if (attestation.key_id !== keyIdForPublicKey(publicKeyPem)) return false;
  try {
    return verify(
      null,
      attestationBytes(attestation.payload),
      createPublicKey(publicKeyPem),
      Buffer.from(attestation.sig, "base64"),
    );
  } catch {
    return false;
  }
}
