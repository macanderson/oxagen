// signer.ts: the key the cloud gateway signs each relay envelope with
// (mcp-studio-spec, Network paths).
//
// It is the Ed25519 key that signs policy bundles and local calls:
// TACHO_BUNDLE_SIGNING_PRIVATE_KEY, a PKCS#8 PEM. Lane M14's local-calls
// signer (packages/handlers/src/mcp-studio/local-calls/signer.ts) reads the
// same variable. A relay trusts the key's public half, which its operator sets
// in RELAY_TRUSTED_KEYS. The relay never learns the key from the broker.
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { envelopeSigningBytes, type RelayEnvelope } from "@oxagen/mcp-studio";
import { relayKeyId } from "./protocol/key-id";

/**
 * The environment variable that holds the signing key. It is the name
 * packages/handlers/src/lib/tacho-bundle-signing.ts exports as
 * TACHO_BUNDLE_SIGNING_KEY_ENV. This package does not import handlers, so it
 * repeats the name.
 */
export const RELAY_SIGNING_KEY_ENV = "TACHO_BUNDLE_SIGNING_PRIVATE_KEY";

export interface RelaySigner {
  /** The first 16 hex characters of the public key's digest. */
  keyId: string;
  publicKeyPem: string;
  /** An Ed25519 signature over the bytes, in padded base64. */
  sign(bytes: Uint8Array): string;
}

/** A signer from an Ed25519 private key in PKCS#8 PEM. Any other key type throws. */
export function relaySignerFromPem(privateKeyPem: string): RelaySigner {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `The relay signing key is ${privateKey.asymmetricKeyType ?? "an unknown type"}, not ed25519. Set ${RELAY_SIGNING_KEY_ENV} to an Ed25519 key in PKCS#8 PEM.`,
    );
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return {
    keyId: relayKeyId(publicKeyPem),
    publicKeyPem,
    sign: (bytes) => sign(null, bytes, privateKey).toString("base64"),
  };
}

/**
 * The signer from the deployment's environment, or undefined when it sets no
 * key. With no signer, the broker signs nothing, so no relay acts.
 */
export function relaySignerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): RelaySigner | undefined {
  const pem = env[RELAY_SIGNING_KEY_ENV];
  if (!pem) return undefined;
  return relaySignerFromPem(pem.replace(/\\n/g, "\n"));
}

/** Every field of a relay envelope except the signature, which signRelayEnvelope adds. */
export type UnsignedRelayEnvelope = Omit<RelayEnvelope, "signature">;

/** The envelope with its signature over the RFC 8785 bytes of every other field. */
export function signRelayEnvelope(unsigned: UnsignedRelayEnvelope, signer: RelaySigner): RelayEnvelope {
  const sig = signer.sign(envelopeSigningBytes(unsigned));
  return { ...unsigned, signature: { key_id: signer.keyId, alg: "ed25519", sig } };
}

/** A fresh nonce: 16 random bytes in base64url, 22 characters. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}
