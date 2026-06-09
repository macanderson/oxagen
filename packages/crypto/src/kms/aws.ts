/**
 * AWS KMS adapter — implements `KmsAdapter` using AWS KMS for DEK wrapping.
 *
 * This is a stub. The constructor throws until AWS KMS is provisioned and the
 * required env vars are set. Flip `INGESTION_CRYPTO_PROVIDER=kms` and supply
 * `AWS_KMS_INGESTION_KEY_ARN` to activate.
 *
 * TODO(kms): Implement using @aws-sdk/client-kms:
 *
 *   generateDataKey:
 *     1. Call kms.send(new GenerateDataKeyCommand({ KeyId, KeySpec: "AES_256" }))
 *     2. Return { plaintext: Plaintext, encrypted: CiphertextBlob }
 *     3. Zero Plaintext from memory after encrypt() uses it (done by envelope.ts)
 *
 *   decryptDataKey:
 *     1. Call kms.send(new DecryptCommand({ CiphertextBlob: encrypted, KeyId }))
 *     2. Return Plaintext
 *     3. Zero Plaintext from memory after decrypt() uses it (done by envelope.ts)
 *
 *   Performance: cache the KMSClient instance (one per region).
 *   Do NOT cache plaintext DEKs — generate fresh per encrypt call for forward secrecy.
 *   The KMS GenerateDataKey API is cheap (~1 ms + ~$0.000003 per call).
 */

import type { KmsAdapter } from "../types";

export function createAwsKmsAdapter(_keyArn: string): KmsAdapter {
  throw new Error(
    "[crypto/kms/aws] AWS KMS adapter is not yet implemented. " +
      "Set INGESTION_CRYPTO_PROVIDER=env and INGESTION_ENCRYPTION_KEY until " +
      "AWS KMS is provisioned. See packages/crypto/src/kms/aws.ts for the " +
      "implementation TODO.",
  );
}
