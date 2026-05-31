/**
 * AWS KMS adapter — concrete implementation of the `KmsAdapter` interface.
 *
 * Uses the AWS SDK v3 KMS client under the hood.  The client is injected
 * rather than constructed internally so callers can share a single client
 * instance across the process and tests can inject a mock.
 *
 * Key spec: `SYMMETRIC_DEFAULT` (AES-256-GCM on the KMS side for wrapping).
 * Data-key spec: 256-bit (AES-256 for the envelope DEK).
 */

import { type KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import type { KmsAdapter } from "../types.js";

export function createAwsKmsAdapter(client: KMSClient): KmsAdapter {
  return {
    async generateDataKey(keyId: string): Promise<{ plaintext: Uint8Array; encrypted: Uint8Array }> {
      const cmd = new GenerateDataKeyCommand({
        KeyId: keyId,
        KeySpec: "AES_256",
      });
      const response = await client.send(cmd);

      if (!response.Plaintext || !response.CiphertextBlob) {
        throw new Error("[crypto/kms/aws] KMS GenerateDataKey returned empty key material");
      }

      return {
        plaintext: response.Plaintext,
        encrypted: response.CiphertextBlob,
      };
    },

    async decryptDataKey(encrypted: Uint8Array, _keyId: string): Promise<Uint8Array> {
      const cmd = new DecryptCommand({
        CiphertextBlob: encrypted,
      });
      const response = await client.send(cmd);

      if (!response.Plaintext) {
        throw new Error("[crypto/kms/aws] KMS Decrypt returned empty plaintext");
      }

      return response.Plaintext;
    },
  };
}
