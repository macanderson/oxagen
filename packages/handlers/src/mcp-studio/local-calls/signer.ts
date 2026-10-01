// signer.ts: the key the cloud gateway signs each local call with
// (mcp-studio-spec, Local servers).
//
// The local gateway verifies every envelope with the public key it received
// at enrollment, which the host file keeps as bundle_public_key_pem. So the
// cloud gateway signs local calls with the same Ed25519 key that signs the
// policy bundle: TACHO_BUNDLE_SIGNING_PRIVATE_KEY, a PKCS#8 PEM. No machine
// needs a second key, and rotating the one key rotates both.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { keyIdForPublicKey } from "@oxagen/recorder/host";
import { TACHO_BUNDLE_SIGNING_KEY_ENV } from "../../lib/tacho-bundle-signing";

export interface LocalCallSigner {
  /** The first 16 hex characters of the public key's digest, as the host computes it. */
  keyId: string;
  publicKeyPem: string;
  /** An Ed25519 signature over the bytes, in padded base64. */
  sign(bytes: Uint8Array): string;
}

/** A signer from an Ed25519 private key in PKCS#8 PEM. Any other key type throws. */
export function localCallSignerFromPem(privateKeyPem: string): LocalCallSigner {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `The local call signing key is ${privateKey.asymmetricKeyType ?? "an unknown type"}, not ed25519. Set ${TACHO_BUNDLE_SIGNING_KEY_ENV} to an Ed25519 key in PKCS#8 PEM.`,
    );
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return {
    keyId: keyIdForPublicKey(publicKeyPem),
    publicKeyPem,
    sign: (bytes) => sign(null, bytes, privateKey).toString("base64"),
  };
}

/**
 * The signer from the deployment's environment, or undefined when it sets no
 * key. With no signer, the cloud gateway signs no local call, so no local
 * server runs.
 */
export function localCallSignerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): LocalCallSigner | undefined {
  const pem = env[TACHO_BUNDLE_SIGNING_KEY_ENV];
  if (!pem) return undefined;
  return localCallSignerFromPem(pem.replace(/\\n/g, "\n"));
}
