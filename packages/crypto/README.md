# @oxagen/crypto

Envelope encryption over a pluggable key-encryption-key (KEK) adapter seam.
The default adapter is **Vercel-native** — the KEK lives in an encrypted
environment variable, with no cloud KMS dependency.

## Contract

```ts
import { encrypt, decrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";

// 32-byte master key (KEK) from an env var, e.g. AUTH_TOKEN_ENCRYPTION_KEY.
const adapter = createLocalKmsAdapter(loadMasterKey(process.env.AUTH_TOKEN_ENCRYPTION_KEY!));

// Encrypt a plaintext string or Buffer.
const ciphertext: Buffer = await encrypt(plaintext, keyId, { adapter });

// Decrypt back to a Buffer.
const plaintext: Buffer = await decrypt(ciphertext, keyId, { adapter });
```

`keyId` is a logical key-version label (e.g. `vercel-native-v1`) stored
per-row so future rotations can be tracked.

## Wire format (v0x01)

```
[1  byte ] version      — always 0x01 for this format
[2  bytes] iv_len       — uint16 big-endian, always 12
[2  bytes] enc_dek_len  — uint16 big-endian
[4  bytes] ct_len       — uint32 big-endian
[12 bytes] iv           — AES-GCM 96-bit nonce  (iv_len bytes)
[N  bytes] enc_dek      — KEK-wrapped 256-bit data encryption key  (enc_dek_len bytes)
[M  bytes] ct + tag     — AES-256-GCM ciphertext || 16-byte auth tag  (ct_len bytes)
```

All three length fields are packed into the fixed 9-byte header first (`1 + 2 + 2 + 4`);
the variable-length payloads follow in order (iv, enc_dek, ct+tag).

A new DEK is generated per `encrypt()` call.  The DEK is wrapped by the KEK
adapter and stored inline in the ciphertext blob.  The plaintext DEK is zeroed
from memory immediately after use.

## Swapping the KEK provider (Policy 2 — no vendor lock-in)

The `KmsAdapter` interface is the vendor seam.  The shipped implementation is
`createLocalKmsAdapter` (native AES-256-GCM key wrapping under an env-held KEK).
To use a cloud KMS (AWS/GCP/Vault) instead:

1. Implement `KmsAdapter` (`generateDataKey` + `decryptDataKey`).
2. Pass your adapter instance via `{ adapter }` to `encrypt` / `decrypt`.

The existing ciphertext format remains valid — no re-encryption needed when
switching providers, as long as the new provider can unwrap the old DEKs.

## Key rotation

Rotating the master key re-wraps future DEKs; existing ciphertexts remain
decryptable only while the previous KEK is still available. To rotate, run a
data re-encryption job: decrypt each row with the old key, re-encrypt with the
new key, write back, and bump the per-row key-version label. The version byte
in the wire format reserves space for a future per-row format migration.

## Environment variables

| Variable                    | Required | Description                                                         |
|-----------------------------|----------|---------------------------------------------------------------------|
| `AUTH_TOKEN_ENCRYPTION_KEY` | Yes      | Base64-encoded 256-bit (32-byte) master key (KEK) that wraps DEKs.  |

`AUTH_TOKEN_ENCRYPTION_KEY` is validated at boot by `@oxagen/config`.
Generate one with `openssl rand -base64 32`.

## Security notes

- Plaintext tokens are never logged anywhere in this module.
- AES-256-GCM auth tag verification is mandatory; any tamper throws.
- Each encrypt call uses a fresh random IV — ciphertext is non-deterministic.
