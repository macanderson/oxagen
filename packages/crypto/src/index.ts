/**
 * @oxagen/crypto — Envelope encryption over an AWS KMS adapter seam.
 *
 * Public surface:
 *   encrypt(plaintext, keyId, { adapter })  → Promise<Buffer>
 *   decrypt(ciphertext, keyId, { adapter }) → Promise<Buffer>
 *   ENVELOPE_VERSION                         (wire format constant)
 *   KmsAdapter (interface)                   (implement to swap KMS providers)
 *   EncryptOptions / DecryptOptions
 *
 * Local KEK adapter (Vercel-native, no cloud KMS):
 *   import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
 *
 * Drizzle column helper:
 *   import { encryptedBytea } from "@oxagen/crypto/drizzle";
 */

export { encrypt, decrypt } from "./envelope";
export { ENVELOPE_VERSION } from "./types";
export type { KmsAdapter, EncryptOptions, DecryptOptions } from "./types";
