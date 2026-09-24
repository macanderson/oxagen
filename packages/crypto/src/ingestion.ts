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

import {
  createLocalKmsAdapter,
  loadMasterKey,
  createAwsKmsAdapter,
} from "./kms/index";
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
 *
 * This is the WRITE-PATH resolver: it selects the adapter for the CURRENTLY
 * configured provider (INGESTION_CRYPTO_PROVIDER). New ciphertext is always
 * written under the active provider, which is what drives the lazy migration —
 * every row re-encrypted while provider=kms picks up keyId "ingestion:kms:v1".
 *
 * NEVER use this to DECRYPT an existing row: a row may have been written under
 * the other provider, and decrypting it requires the adapter that matches the
 * row's stored keyId, not the current global env var. Use
 * {@link resolveIngestionCryptoAdapterForKeyId} on every decrypt path instead.
 *
 * Cheap for both providers. The env provider decodes a base64 key; the KMS
 * provider returns the one adapter this process holds for the configured ARN
 * (see {@link buildKmsAdapter}), so calling this per request or per row costs
 * no new `KMSClient`.
 */
export function createIngestionCryptoAdapter(): IngestionCryptoAdapter {
  const provider = process.env["INGESTION_CRYPTO_PROVIDER"] ?? "env";

  if (provider === "kms") {
    return buildKmsAdapter();
  }

  if (provider === "env") {
    return buildEnvAdapter();
  }

  // An unrecognized value ("KMS", " kms", "aws") must not fall through to the
  // env provider: with INGESTION_ENCRYPTION_KEY still set during a migration
  // window the app would start, encrypt every new credential under the local
  // key, and give the operator no sign that KMS was never engaged.
  throw new Error(
    `[crypto/ingestion] INGESTION_CRYPTO_PROVIDER=${JSON.stringify(provider)} is not a ` +
      'known provider — cannot select an encryption provider. Expected "env" or "kms".',
  );
}

/**
 * DECRYPT-PATH resolver — selects the adapter able to unwrap an envelope that
 * was written with `storedKeyId`, INDEPENDENT of the current
 * INGESTION_CRYPTO_PROVIDER.
 *
 * This is what makes the documented lazy-migration contract real. The envelope
 * stores its provider as `keyId` ("ingestion:env:v1" vs "ingestion:kms:v1");
 * routing on that value means a row encrypted under the local (env) provider
 * keeps decrypting via the local adapter after the deployment flips to KMS, and
 * an AWS-KMS-wrapped row keeps decrypting via AWS KMS after a flip back to env.
 *
 * Without this routing, an AWS-wrapped data key (≈184-byte CiphertextBlob) fed
 * to the local adapter (which expects a 60-byte iv|tag|dek blob) fails with the
 * cryptic "wrapped data key has unexpected length 184 (expected 60)" — and an
 * env-wrapped key fed to AWS KMS fails just as opaquely. Routing on the stored
 * keyId turns those into either a correct decrypt (when the matching provider's
 * key material is configured) or an actionable "this provider's key is not
 * configured" error that names the missing env var.
 *
 * A `"ingestion:kms:v1"` row reuses the process's adapter for the configured
 * ARN, so resolving per row is safe.
 *
 * @param storedKeyId  The `keyId` field read back from the stored envelope.
 * @throws if `storedKeyId` is unrecognized, or the provider it names is not
 *         configured in this runtime (the message names the missing env var).
 */
export function resolveIngestionCryptoAdapterForKeyId(
  storedKeyId: string,
): IngestionCryptoAdapter {
  if (storedKeyId === INGESTION_KEY_ID_KMS) {
    return buildKmsAdapter({
      context: `credential was encrypted with the AWS KMS provider (keyId="${storedKeyId}")`,
    });
  }

  if (storedKeyId === INGESTION_KEY_ID_ENV) {
    return buildEnvAdapter({
      context: `credential was encrypted with the local (env) provider (keyId="${storedKeyId}")`,
    });
  }

  throw new Error(
    `[crypto/ingestion] unrecognized credential keyId "${storedKeyId}" — cannot select a ` +
      `decryption provider. Expected "${INGESTION_KEY_ID_ENV}" or "${INGESTION_KEY_ID_KMS}".`,
  );
}

/**
 * One AWS adapter per key ARN for the life of the process.
 *
 * Every adapter owns a `KMSClient`, and a new client means a new credential
 * resolution and a new TLS connection before its first call. The evidence
 * store resolves an adapter for every frame body it writes, up to 200 per
 * tacho batch, so building one per call made each body pay that setup on top
 * of its `GenerateDataKey`, and production ingest took 6 to 16 seconds a
 * batch against a host that gives up at 15. The client holds no key material:
 * a fresh data key is still generated for every `encrypt()`.
 */
const kmsAdapters = new Map<string, KmsAdapter>();

/** Build the AWS-KMS-backed adapter, requiring AWS_KMS_INGESTION_KEY_ARN. */
function buildKmsAdapter(opts?: { context?: string }): IngestionCryptoAdapter {
  const keyArn = process.env["AWS_KMS_INGESTION_KEY_ARN"];
  if (!keyArn) {
    throw new Error(
      `[crypto/ingestion] ${opts?.context ?? "INGESTION_CRYPTO_PROVIDER=kms"} ` +
        "but AWS_KMS_INGESTION_KEY_ARN is not set — cannot proceed. " +
        "Set AWS_KMS_INGESTION_KEY_ARN to the wrapping key's ARN " +
        "(e.g. arn:aws:kms:us-east-2:ACCOUNT_ID:key/KEY_ID).",
    );
  }
  let adapter = kmsAdapters.get(keyArn);
  if (adapter === undefined) {
    adapter = createAwsKmsAdapter(keyArn);
    kmsAdapters.set(keyArn, adapter);
  }
  return { adapter, keyId: INGESTION_KEY_ID_KMS };
}

/** Build the local (env) adapter, requiring INGESTION_ENCRYPTION_KEY. */
function buildEnvAdapter(opts?: { context?: string }): IngestionCryptoAdapter {
  const rawKey = process.env["INGESTION_ENCRYPTION_KEY"];
  if (!rawKey) {
    throw new Error(
      `[crypto/ingestion] ${opts?.context ?? "INGESTION_CRYPTO_PROVIDER=env"} ` +
        "but INGESTION_ENCRYPTION_KEY is not set — cannot proceed. " +
        "Generate/restore it with: openssl rand -base64 32",
    );
  }
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(rawKey)),
    keyId: INGESTION_KEY_ID_ENV,
  };
}
