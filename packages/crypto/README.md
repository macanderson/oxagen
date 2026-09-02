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

The `KmsAdapter` interface is the vendor seam. Two adapters ship in the box:

- `createLocalKmsAdapter` — AES-256-GCM key wrapping under a KEK held in an env
  var. No cloud dependency. This is the default.
- `createAwsKmsAdapter` — wraps and unwraps DEKs with AWS KMS. Give it a full
  key ARN; the region is read out of the ARN, and both the wrap and the unwrap
  call pin that key.

To add a third provider (GCP, Vault, an HSM):

1. Implement `KmsAdapter` (`generateDataKey` + `decryptDataKey`).
2. Pass your adapter instance via `{ adapter }` to `encrypt` / `decrypt`.

A wrapped DEK can only be unwrapped by the provider that wrapped it, so a
ciphertext written under one provider still needs that provider on the read
path. Store a per-row key-version label and route on it — that is exactly what
`resolveIngestionCryptoAdapterForKeyId` does for connector credentials.

## Ingestion credentials

Connector credentials in `ingestion.auth_credentials` use two helpers instead of
building an adapter by hand:

- `createIngestionCryptoAdapter()` — the **write** path. It picks the adapter for
  whichever provider `INGESTION_CRYPTO_PROVIDER` currently names, and returns the
  `keyId` to store next to the ciphertext.
- `resolveIngestionCryptoAdapterForKeyId(storedKeyId)` — the **read** path. It
  picks the adapter from the row's own stored `keyId`, so a row written before a
  provider switch still decrypts afterwards.

Never decrypt with the write-path helper. A row may predate the current setting.

Switching from the env KEK to AWS KMS is therefore a flip, not a migration:
provision the key, set `AWS_KMS_INGESTION_KEY_ARN`, set
`INGESTION_CRYPTO_PROVIDER=kms`. Old rows keep decrypting under the env KEK and
pick up the KMS key the next time they are written.

Both helpers build a new adapter on every call, and for the KMS provider that
means a new `KMSClient`. Build one per request or per batch and reuse it — do
not call either helper inside a per-row loop.

## Key rotation

Rotating the master key re-wraps future DEKs; existing ciphertexts remain
decryptable only while the previous KEK is still available. To rotate, run a
data re-encryption job: decrypt each row with the old key, re-encrypt with the
new key, write back, and bump the per-row key-version label. The version byte
in the wire format reserves space for a future per-row format migration.

## Environment variables

| Variable                    | Required                | Description                                                                    |
|-----------------------------|-------------------------|--------------------------------------------------------------------------------|
| `AUTH_TOKEN_ENCRYPTION_KEY` | Yes                     | Base64 256-bit (32-byte) KEK for auth and plugin credentials.                  |
| `INGESTION_CRYPTO_PROVIDER` | No (defaults to `env`)  | `env` for the local KEK, `kms` for AWS KMS. Applies to connector credentials.  |
| `INGESTION_ENCRYPTION_KEY`  | When provider is `env`  | Base64 256-bit (32-byte) KEK for connector credentials.                        |
| `AWS_KMS_INGESTION_KEY_ARN` | When provider is `kms`  | Full ARN of the KMS key that wraps connector DEKs. The region comes from it.   |

`AUTH_TOKEN_ENCRYPTION_KEY` is validated at boot by `@oxagen/config`.
Generate any of the base64 keys with `openssl rand -base64 32`.

## Security notes

- Plaintext tokens are never logged anywhere in this module.
- AES-256-GCM auth tag verification is mandatory; any tamper throws.
- Each encrypt call uses a fresh random IV — ciphertext is non-deterministic.
- The envelope carries no additional authenticated data. Nothing inside a
  ciphertext ties it to the row, tenant, or column it was stored in, so anyone
  who can overwrite one stored blob with another blob wrapped under the same KEK
  gets a clean decrypt of the substituted value. Authorization on the storage
  layer is what prevents that today.
- The local KEK wraps every DEK under one long-lived key with a random 96-bit
  nonce. NIST SP 800-38D caps a random-IV GCM key at roughly 2^32 invocations;
  rotate the KEK well before a deployment approaches that many credential
  writes.
