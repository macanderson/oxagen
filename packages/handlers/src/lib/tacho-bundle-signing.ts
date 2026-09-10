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
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { jcs, type JsonValue } from "@oxagen/tacho";
import {
  keyIdForPublicKey,
  verifyBundle as verifyBundleOffline,
} from "@oxagen/tacho/host";
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
  return keyIdForPublicKey(publicKeyPem);
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

/** Verify a bundle against a public key; the same check the host runs offline. */
export function verifyBundle(
  bundle: PolicyBundle,
  publicKeyPem: string,
): boolean {
  return verifyBundleOffline(bundle, publicKeyPem).ok;
}

/** The signer from the environment; undefined when the deployment has no key. */
export function bundleSignerFromEnv(): BundleSigner | undefined {
  const pem = process.env[TACHO_BUNDLE_SIGNING_KEY_ENV];
  if (!pem) return undefined;
  return bundleSignerFromPem(pem.replace(/\\n/g, "\n"));
}
