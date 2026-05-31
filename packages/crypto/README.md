# @oxagen/crypto

Envelope encryption over an AWS KMS adapter seam.

## Contract

```ts
import { encrypt, decrypt } from "@oxagen/crypto";
import { createAwsKmsAdapter } from "@oxagen/crypto/kms";
import { KMSClient } from "@aws-sdk/client-kms";

const kmsClient = new KMSClient({ region: "us-east-2" });
const adapter = createAwsKmsAdapter(kmsClient);

// Encrypt a plaintext string or Buffer.
const ciphertext: Buffer = await encrypt(plaintext, keyId, { adapter });

// Decrypt back to a Buffer.
const plaintext: Buffer = await decrypt(ciphertext, keyId, { adapter });
```

`keyId` is the KMS CMK id or ARN from config (`AUTH_TOKEN_KMS_KEY_ID`).

## Wire format (v0x01)

```
[1  byte ] version      — always 0x01 for this format
[2  bytes] iv_len       — uint16 big-endian, always 12
[12 bytes] iv           — AES-GCM 96-bit nonce
[2  bytes] enc_dek_len  — uint16 big-endian
[N  bytes] enc_dek      — KMS-wrapped 256-bit data encryption key
[4  bytes] ct_len       — uint32 big-endian
[M  bytes] ct + tag     — AES-256-GCM ciphertext || 16-byte auth tag
```

A new DEK is generated per `encrypt()` call.  The DEK is wrapped by KMS and stored
inline in the ciphertext blob.  The plaintext DEK is zeroed from memory immediately
after use.

## Swapping the KMS provider (Policy 2 — no vendor lock-in)

The `KmsAdapter` interface is the vendor seam.  To use a different provider:

1. Implement `KmsAdapter` (`generateDataKey` + `decryptDataKey`).
2. Pass your adapter instance via `{ adapter }` to `encrypt` / `decrypt`.

The existing ciphertext format remains valid — no re-encryption needed when
switching providers, as long as the new provider can unwrap the old DEKs.

## Key rotation

KMS key rotation (automatic or manual) re-wraps future DEKs; existing
ciphertexts remain decryptable because they carry their own wrapped DEK.
To re-wrap existing ciphertexts under a new CMK, run a data re-encryption
job: decrypt each row with the old key, re-encrypt with the new key, write
back.  The version byte in the wire format reserves space for a future
per-row format migration if needed.

## Environment variables

| Variable                | Required | Description                                      |
|-------------------------|----------|--------------------------------------------------|
| `AUTH_TOKEN_KMS_KEY_ID` | Yes      | KMS CMK id / ARN used to wrap OAuth token DEKs. |
| `AWS_REGION`            | Yes      | AWS region where the CMK lives (`us-east-2`).    |

`AUTH_TOKEN_KMS_KEY_ID` is validated at boot by `@oxagen/config`.

## Security notes

- Plaintext tokens are never logged anywhere in this module.
- AES-256-GCM auth tag verification is mandatory; any tamper throws.
- Each encrypt call uses a fresh random IV — ciphertext is non-deterministic.
