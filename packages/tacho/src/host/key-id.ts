import { digestJcs } from "../digest";

/**
 * The bundle signing key id is the first 16 hex chars of the digest of the
 * public key PEM, so rotation is visible by name. Shared by the control
 * plane's signer and the host's verifier.
 */
export function keyIdForPublicKey(publicKeyPem: string): string {
  return digestJcs(publicKeyPem).slice("sha256:".length, "sha256:".length + 16);
}
