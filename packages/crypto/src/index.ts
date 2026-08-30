/**
 * @oxagen/crypto — Envelope encryption over a pluggable KEK adapter seam.
 *
 * Public surface:
 *   encrypt(plaintext, keyId, { adapter })  → Promise<Buffer>
 *   decrypt(ciphertext, keyId, { adapter }) → Promise<Buffer>
 *   ENVELOPE_VERSION                         (wire format constant)
 *   KmsAdapter (interface)                   (implement to swap KEK providers)
 *   EncryptOptions / DecryptOptions
 *
 * Ingestion credential helpers (provider selection + decrypt-path routing):
 *   createIngestionCryptoAdapter()             — write path, follows the env var
 *   resolveIngestionCryptoAdapterForKeyId(id)  — read path, follows the stored keyId
 *   INGESTION_KEY_ID_ENV / INGESTION_KEY_ID_KMS
 *
 * Concrete adapters (subpath export):
 *   import { createLocalKmsAdapter, loadMasterKey, createAwsKmsAdapter }
 *     from "@oxagen/crypto/kms";
 *
 * The Drizzle column helper for encrypted-bytea columns lives in
 * @oxagen/database (see packages/database/src/schema/_mixins.ts `bytea`).
 * @oxagen/crypto does not depend on @oxagen/database, so it cannot own a
 * Drizzle-typed column helper without taking on that dependency.
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
