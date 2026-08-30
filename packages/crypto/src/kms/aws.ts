import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";
import type { KmsAdapter } from "../types";

/**
 * Extract the AWS region from a full KMS ARN.
 *
 * Only fully-qualified ARNs are accepted — `arn:aws:kms:<region>:<account>:key/<id>`
 * or `arn:aws:kms:<region>:<account>:alias/<name>`. A bare key id or bare
 * `alias/<name>` carries no region, so it is rejected rather than silently
 * falling back to an ambient default region.
 */
function regionFromArn(arn: string): string {
  const region = arn.split(":")[3];
  if (!region) {
    throw new Error(
      `[crypto/kms/aws] Cannot parse AWS region from KMS ARN: "${arn}"`,
    );
  }
  return region;
}

/**
 * Build a `KmsAdapter` that wraps/unwraps DEKs using AWS KMS.
 *
 * The KMSClient is created once per adapter instance (bound to the region
 * extracted from `keyArn`). The adapter is intended to be constructed once
 * at app startup and reused across requests.
 *
 * DEK plaintext is NEVER cached — a fresh DEK is generated on every
 * `encrypt()` call for forward secrecy. Zeroing of the plaintext DEK after
 * use is handled by `envelope.ts`.
 */
export function createAwsKmsAdapter(keyArn: string): KmsAdapter {
  if (!keyArn) {
    throw new Error("[crypto/kms/aws] keyArn must not be empty");
  }

  const client = new KMSClient({ region: regionFromArn(keyArn) });

  return {
    async generateDataKey(_keyId: string) {
      const response = await client.send(
        new GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: "AES_256" }),
      );
      if (!response.Plaintext || !response.CiphertextBlob) {
        throw new Error(
          "[crypto/kms/aws] GenerateDataKey returned empty Plaintext or CiphertextBlob",
        );
      }
      return {
        plaintext: response.Plaintext,
        encrypted: response.CiphertextBlob,
      };
    },

    async decryptDataKey(encrypted: Uint8Array, _keyId: string) {
      const response = await client.send(
        new DecryptCommand({ CiphertextBlob: encrypted, KeyId: keyArn }),
      );
      if (!response.Plaintext) {
        throw new Error("[crypto/kms/aws] Decrypt returned empty Plaintext");
      }
      return response.Plaintext;
    },
  };
}
