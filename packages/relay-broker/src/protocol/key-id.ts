// key-id.ts: the id of a signing key, as a relay envelope's signature names it.
//
// The id is the first 16 hex characters of the SHA-256 of the public key's
// PEM text in its RFC 8785 form. It is the id tacho's keyIdForPublicKey gives
// the same key, so the one key that signs policy bundles and local calls has
// one id everywhere. The relay computes it here so its bundle carries no tacho
// code. A test checks the two agree.
import { createPublicKey } from "node:crypto";
import { canonicalDigest } from "@oxagen/mcp-studio";

/** The key id of a public key given as PEM text exactly as the signer exports it. */
export function relayKeyId(publicKeyPem: string): string {
  return canonicalDigest(publicKeyPem).slice("sha256:".length, "sha256:".length + 16);
}

/**
 * An Ed25519 public key in the PEM form Node exports, which is the form the
 * signer hashes. A key pasted with other line breaks gets the same id.
 *
 * Throws when the text is not an Ed25519 public key. Node would derive a
 * public key from a private one, so a private key is refused by name: the
 * relay must never hold the key that signs its envelopes.
 */
export function normalizePublicKeyPem(pem: string): string {
  if (pem.includes("PRIVATE KEY")) {
    throw new Error("This is a private key. Give the relay only the public half of the signing key.");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`The key is ${key.asymmetricKeyType ?? "of an unknown type"}, and a relay trusts only Ed25519 keys.`);
  }
  return key.export({ type: "spki", format: "pem" }).toString();
}
