/**
 * Ed25519 signing of the policy bundle a host caches (spec section 7.1).
 *
 * The bundle is signed over the RFC 8785 canonical JSON of every member
 * except `signature`, with the deployment's private key from
 * `TACHO_BUNDLE_SIGNING_PRIVATE_KEY` (PKCS#8 PEM). The matching public key
 * travels to the host at enrollment, so `tacho-hook` verifies a cached
 * bundle offline and refuses one it cannot verify, even with the daemon and
 * the network down (fail-closed enforcement).
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { digestJcs, jcs, type JsonValue } from "@oxagen/tacho";
import type { PolicyBundle } from "@oxagen/oxagen/tacho/schemas";

export const TACHO_BUNDLE_SIGNING_KEY_ENV = "TACHO_BUNDLE_SIGNING_PRIVATE_KEY";

export interface BundleSigner {
  keyId: string;
  publicKeyPem: string;
  sign: (bundle: Omit<PolicyBundle, "signature">) => PolicyBundle["signature"];
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** The key id is the digest of the public key, so rotation is visible by name. */
export function keyIdFor(publicKeyPem: string): string {
  return digestJcs(publicKeyPem).slice("sha256:".length, "sha256:".length + 16);
}

export function bundleSignerFromPem(privateKeyPem: string): BundleSigner {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `bundle signing key must be ed25519, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = keyIdFor(publicKeyPem);
  return {
    keyId,
    publicKeyPem,
    sign: (bundle) => ({
      key_id: keyId,
      alg: "ed25519",
      sig: sign(
        null,
        Buffer.from(jcs(toJson(bundle)), "utf8"),
        privateKey,
      ).toString("base64"),
    }),
  };
}

/** Verify a bundle against a public key; what the host does offline. */
export function verifyBundle(
  bundle: PolicyBundle,
  publicKeyPem: string,
): boolean {
  const { signature, ...unsigned } = bundle;
  if (
    signature.alg !== "ed25519" ||
    signature.key_id !== keyIdFor(publicKeyPem)
  ) {
    return false;
  }
  try {
    return verify(
      null,
      Buffer.from(jcs(toJson(unsigned)), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.sig, "base64"),
    );
  } catch {
    return false;
  }
}

/** The signer from the environment; undefined when the deployment has no key. */
export function bundleSignerFromEnv(): BundleSigner | undefined {
  const pem = process.env[TACHO_BUNDLE_SIGNING_KEY_ENV];
  if (!pem) return undefined;
  return bundleSignerFromPem(pem.replace(/\\n/g, "\n"));
}
