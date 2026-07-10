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
 * Drizzle column helper for encrypted-bytea columns lives in
 * @oxagen/database (see packages/database/src/schema/_mixins.ts `bytea`) —
 * @oxagen/crypto has no dependency on @oxagen/database, so it cannot own a
 * Drizzle-typed column helper without introducing one.
 */

export { encrypt, decrypt } from "./envelope";
export { ENVELOPE_VERSION } from "./types";
export type { KmsAdapter, EncryptOptions, DecryptOptions } from "./types";
export {
  createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId,
  INGESTION_KEY_ID_ENV,
  INGESTION_KEY_ID_KMS,
} from "./ingestion";
export type { IngestionCryptoAdapter } from "./ingestion";
