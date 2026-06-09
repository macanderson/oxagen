/**
 * Ingestion pipeline crypto factory.
 *
 * Returns the KmsAdapter and keyId the ingestion pipeline uses to encrypt and
 * decrypt connector credentials stored in `ingestion.auth_credentials`.
 *
 * Env vars:
 *
 *   INGESTION_CRYPTO_PROVIDER   "env" (default) | "kms"
 *   INGESTION_ENCRYPTION_KEY    base64-encoded 32-byte master key (required when provider=env)
 *                               Generate: openssl rand -base64 32
 *   AWS_KMS_INGESTION_KEY_ARN   KMS key ARN (required when provider=kms)
 *                               e.g. arn:aws:kms:us-east-2:ACCOUNT_ID:key/KEY_ID
 *
 * Switch from env to KMS:
 *   1. Provision a KMS symmetric key in us-east-2
 *   2. Set AWS_KMS_INGESTION_KEY_ARN to the key ARN
 *   3. Flip INGESTION_CRYPTO_PROVIDER=kms
 *   4. Existing rows (keyId="ingestion:env:v1") continue to decrypt via the
 *      local adapter until they are re-encrypted (lazy migration on next write).
 */

import { createLocalKmsAdapter, loadMasterKey, createAwsKmsAdapter } from "./kms/index";
import type { KmsAdapter } from "./types";

export const INGESTION_KEY_ID_ENV = "ingestion:env:v1";
export const INGESTION_KEY_ID_KMS = "ingestion:kms:v1";

export interface IngestionCryptoAdapter {
  adapter: KmsAdapter;
  /** Passed as the `keyId` argument to `encrypt()` / stored in the envelope for routing. */
  keyId: string;
}

/**
 * Returns the KmsAdapter and keyId for ingestion credential encryption.
 * Called once at app startup and cached by the caller.
 */
export function createIngestionCryptoAdapter(): IngestionCryptoAdapter {
  const provider = process.env["INGESTION_CRYPTO_PROVIDER"] ?? "env";

  if (provider === "kms") {
    const keyArn = process.env["AWS_KMS_INGESTION_KEY_ARN"];
    if (!keyArn) {
      throw new Error(
        "[crypto/ingestion] AWS_KMS_INGESTION_KEY_ARN must be set when INGESTION_CRYPTO_PROVIDER=kms",
      );
    }
    return { adapter: createAwsKmsAdapter(keyArn), keyId: INGESTION_KEY_ID_KMS };
  }

  const rawKey = process.env["INGESTION_ENCRYPTION_KEY"];
  if (!rawKey) {
    throw new Error(
      "[crypto/ingestion] INGESTION_ENCRYPTION_KEY is not set. " +
        "Generate with: openssl rand -base64 32",
    );
  }

  return {
    adapter: createLocalKmsAdapter(loadMasterKey(rawKey)),
    keyId: INGESTION_KEY_ID_ENV,
  };
}
