// key.ts: the Ed25519 key that signs done-record attestations, and the
// document Oxagen publishes so anyone can check a signature without Oxagen.
//
// The key id follows the rule the tacho policy bundle and the run attestation
// already use: the first 16 hex characters of the RFC 8785 digest of the public
// key PEM. A rotated key shows up as a new id.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { digestJcs } from "@oxagen/run-evidence";
import { DONE_RECORD_PREDICATE_TYPE } from "../types";
import { DSSE_IN_TOTO_PAYLOAD_TYPE, IN_TOTO_STATEMENT_TYPE } from "./statement";

/** An Ed25519 signing key with its public half and key id. */
export interface DoneAttestationKey {
  keyId: string;
  publicKeyPem: string;
  privateKey: KeyObject;
}

/** The public key document served at `DONE_KEY_PATH`. */
export interface PublishedDoneKey {
  keyid: string;
  alg: "ed25519";
  public_key_pem: string;
  statement_type: typeof IN_TOTO_STATEMENT_TYPE;
  payload_type: typeof DSSE_IN_TOTO_PAYLOAD_TYPE;
  predicate_type: typeof DONE_RECORD_PREDICATE_TYPE;
}

/** The key id of a public key PEM. */
export function keyIdForPublicKeyPem(publicKeyPem: string): string {
  return digestJcs(publicKeyPem).slice("sha256:".length, "sha256:".length + 16);
}

/** The signing key for a private key object. Refuses anything but Ed25519. */
export function doneAttestationKey(privateKey: KeyObject): DoneAttestationKey {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError(
      `done attestation key must be an ed25519 private key, got a ${privateKey.type} ${String(privateKey.asymmetricKeyType)} key`,
    );
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return { keyId: keyIdForPublicKeyPem(publicKeyPem), publicKeyPem, privateKey };
}

/** The signing key from a PKCS#8 PEM. Refuses anything but Ed25519. */
export function doneAttestationKeyFromPem(privateKeyPem: string): DoneAttestationKey {
  return doneAttestationKey(createPrivateKey(privateKeyPem));
}

/** The Ed25519 public key object for a PEM. Refuses any other key type. */
export function donePublicKey(publicKeyPem: string): KeyObject {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(
      `done attestation public key must be ed25519, got ${String(key.asymmetricKeyType)}`,
    );
  }
  return key;
}

/** The document that tells a verifier which key signs done-record attestations. */
export function publishedDoneKey(publicKeyPem: string): PublishedDoneKey {
  const normalized = donePublicKey(publicKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    keyid: keyIdForPublicKeyPem(normalized),
    alg: "ed25519",
    public_key_pem: normalized,
    statement_type: IN_TOTO_STATEMENT_TYPE,
    payload_type: DSSE_IN_TOTO_PAYLOAD_TYPE,
    predicate_type: DONE_RECORD_PREDICATE_TYPE,
  };
}
