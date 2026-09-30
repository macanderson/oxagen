// sign.ts: sign a done-record statement as a DSSE envelope, and check one.
//
// The payload is the statement's RFC 8785 bytes, so one statement always gives
// the same payload, and Ed25519 gives the same signature for it. The envelope
// digest is therefore stable, and it is what `attestation_ref` stores.
//
// verifyDoneAttestation needs only the envelope and the published public key.
// It reads the envelope as untrusted input and never throws on a bad one.
import { jcsBytes, sha256Digest, type Sha256Digest } from "@oxagen/run-evidence";
import { DONE_RECORD_PREDICATE_TYPE } from "../types";
import { openEnvelope, parseEnvelope, signEnvelope, type DsseEnvelope } from "./dsse";
import { donePublicKey, keyIdForPublicKeyPem, type DoneAttestationKey } from "./key";
import {
  DSSE_IN_TOTO_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  type DoneStatement,
} from "./statement";

/** A signed done-record statement and the digest that names it. */
export interface DoneAttestation {
  envelope: DsseEnvelope;
  /** SHA-256 over the envelope's RFC 8785 bytes. Store it as `attestation_ref`. */
  ref: Sha256Digest;
}

/** Why an envelope did not verify. */
export type DoneAttestationRefusal =
  | "malformed_envelope"
  | "wrong_payload_type"
  | "bad_signature"
  | "malformed_statement"
  | "wrong_statement_type"
  | "wrong_predicate_type";

export type DoneAttestationCheck =
  | { ok: true; statement: DoneStatement; keyid: string }
  | { ok: false; reason: DoneAttestationRefusal };

/** The digest `attestation_ref` stores for an envelope. */
export function doneAttestationRef(envelope: DsseEnvelope): Sha256Digest {
  return sha256Digest(jcsBytes(envelope));
}

/** True when the envelope's payload is exactly this statement's canonical bytes. */
export function envelopeCarries(envelope: DsseEnvelope, statement: DoneStatement): boolean {
  return Buffer.from(envelope.payload, "base64").equals(jcsBytes(statement));
}

/** Sign a statement with the done attestation key. */
export function signDoneAttestation(
  statement: DoneStatement,
  key: DoneAttestationKey,
): DoneAttestation {
  const envelope = signEnvelope(
    DSSE_IN_TOTO_PAYLOAD_TYPE,
    jcsBytes(statement),
    key.privateKey,
    key.keyId,
  );
  return { envelope, ref: doneAttestationRef(envelope) };
}

function readStatement(bytes: Buffer): DoneAttestationCheck {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_statement" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "malformed_statement" };
  }
  const statement = value as Record<string, unknown>;
  if (statement._type !== IN_TOTO_STATEMENT_TYPE) {
    return { ok: false, reason: "wrong_statement_type" };
  }
  if (statement.predicateType !== DONE_RECORD_PREDICATE_TYPE) {
    return { ok: false, reason: "wrong_predicate_type" };
  }
  const { subject, predicate } = statement;
  if (!Array.isArray(subject) || typeof predicate !== "object" || predicate === null) {
    return { ok: false, reason: "malformed_statement" };
  }
  return { ok: true, statement: value as DoneStatement, keyid: "" };
}

/**
 * Check an envelope against a published public key. `ok` is true only when a
 * signature verifies, the payload type is in-toto's, and the statement carries
 * the done-record predicate type. A bad envelope is a refusal. A public key
 * that is not Ed25519 throws, because the caller chose it.
 */
export function verifyDoneAttestation(
  envelope: unknown,
  publicKeyPem: string,
): DoneAttestationCheck {
  const parsed = parseEnvelope(envelope);
  if (!parsed) return { ok: false, reason: "malformed_envelope" };
  if (parsed.payloadType !== DSSE_IN_TOTO_PAYLOAD_TYPE) {
    return { ok: false, reason: "wrong_payload_type" };
  }
  const publicKey = donePublicKey(publicKeyPem);
  const keyid = keyIdForPublicKeyPem(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  const payload = openEnvelope(parsed, publicKey, keyid);
  if (!payload) return { ok: false, reason: "bad_signature" };
  const read = readStatement(payload);
  return read.ok ? { ...read, keyid } : read;
}
