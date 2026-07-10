/**
 * reseller-secret.ts — envelope encryption for the per-org reseller Stripe key.
 *
 * Mirrors the ingestion connector-credential pattern (@oxagen/crypto over a KMS
 * adapter seam): the plaintext key never touches the DB — only the wrapped
 * ciphertext + the crypto keyId (for decrypt routing) + a last-4 fingerprint.
 *
 * Reuses the platform master-key material so the feature ships without a new
 * required prod secret: BILLING_ENCRYPTION_KEY if set, else the already-present
 * INGESTION_ENCRYPTION_KEY. The distinct `billing:reseller:env:v1` keyId lets
 * billing rotate independently of ingestion later.
 */

import { encrypt, decrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";

export const RESELLER_KEY_ID = "billing:reseller:env:v1";

function resolveMasterKey(): string {
  const raw =
    process.env["BILLING_ENCRYPTION_KEY"] ??
    process.env["INGESTION_ENCRYPTION_KEY"];
  if (!raw) {
    throw new Error(
      "[billing/reseller] neither BILLING_ENCRYPTION_KEY nor INGESTION_ENCRYPTION_KEY " +
        "is set — cannot encrypt/decrypt the reseller Stripe key. " +
        "Generate/restore it with: openssl rand -base64 32",
    );
  }
  return raw;
}

function localAdapter(): KmsAdapter {
  return createLocalKmsAdapter(loadMasterKey(resolveMasterKey()));
}

/** Wrap a reseller Stripe secret key. Returns the ciphertext + its routing keyId. */
export async function encryptResellerSecret(
  plaintext: string,
): Promise<{ ciphertext: Buffer; keyId: string }> {
  const ciphertext = await encrypt(plaintext, RESELLER_KEY_ID, {
    adapter: localAdapter(),
  });
  return { ciphertext, keyId: RESELLER_KEY_ID };
}

/** Unwrap a stored reseller Stripe secret key by the keyId it was written under. */
export async function decryptResellerSecret(
  ciphertext: Buffer,
  keyId: string,
): Promise<string> {
  if (keyId !== RESELLER_KEY_ID) {
    // v1 wires only the local env provider; an unknown keyId is a real error, not
    // a silent empty key that would push a $0 invoice from the wrong account.
    throw new Error(
      `[billing/reseller] unrecognized reseller key id "${keyId}" — cannot select a ` +
        `decryption provider (expected "${RESELLER_KEY_ID}").`,
    );
  }
  const plain = await decrypt(ciphertext, keyId, { adapter: localAdapter() });
  return plain.toString("utf8");
}

/** Non-secret fingerprint safe to surface in the UI. */
export function secretLast4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}
