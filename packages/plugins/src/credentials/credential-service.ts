/**
 * Envelope-encrypts plugin credential secrets (OAuth access/refresh tokens,
 * API-key/header secrets, OAuth client secret) for storage in mcp.credentials.
 *
 * Modeled on packages/auth/src/token-encryption.ts: the service layer encrypts
 * before write and decrypts after read; the *_enc columns store opaque Buffers.
 * NEVER log plaintext secret values in this module.
 */
import { encrypt, decrypt } from "@oxagen/crypto";
import type { ResolvedKms } from "./kms";

export { MCP_CREDENTIAL_KEY_ID } from "./kms";

/** Plaintext secrets supplied by the caller for encryption. */
export interface CredentialPlaintext {
  accessToken?: string | null;
  refreshToken?: string | null;
  secret?: string | null;
  oauthClientSecret?: string | null;
}

/** Encrypted column values written to mcp.credentials. */
export interface CredentialCiphertext {
  accessTokenEnc: Buffer | null;
  refreshTokenEnc: Buffer | null;
  secretEnc: Buffer | null;
  oauthClientSecretEnc: Buffer | null;
  tokenKmsKeyId: string;
}

async function enc1(
  value: string | null | undefined,
  kms: ResolvedKms,
): Promise<Buffer | null> {
  if (value == null || value === "") return null;
  return encrypt(value, kms.keyId, { adapter: kms.adapter });
}

async function dec1(
  value: Buffer | null | undefined,
  keyId: string,
  kms: ResolvedKms,
): Promise<string | null> {
  if (value == null) return null;
  const buf = await decrypt(value, keyId, { adapter: kms.adapter });
  return buf.toString("utf8");
}

/** Encrypt all secret fields. Returns only the encrypted columns + key id. */
export async function encryptCredentialSecrets(
  data: CredentialPlaintext,
  kms: ResolvedKms,
): Promise<CredentialCiphertext> {
  const [accessTokenEnc, refreshTokenEnc, secretEnc, oauthClientSecretEnc] =
    await Promise.all([
      enc1(data.accessToken, kms),
      enc1(data.refreshToken, kms),
      enc1(data.secret, kms),
      enc1(data.oauthClientSecret, kms),
    ]);
  return {
    accessTokenEnc,
    refreshTokenEnc,
    secretEnc,
    oauthClientSecretEnc,
    tokenKmsKeyId: kms.keyId,
  };
}

/** Encrypted column values read from mcp.credentials, for decryption. */
export interface CredentialCiphertextRead {
  tokenKmsKeyId: string | null;
  accessTokenEnc?: Buffer | null;
  refreshTokenEnc?: Buffer | null;
  secretEnc?: Buffer | null;
  oauthClientSecretEnc?: Buffer | null;
}

/** Decrypt all secret fields. Rows without a key id predate encryption. */
export async function decryptCredentialSecrets(
  data: CredentialCiphertextRead,
  kms: ResolvedKms,
): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
  secret: string | null;
  oauthClientSecret: string | null;
}> {
  const keyId = data.tokenKmsKeyId;
  if (!keyId) {
    return {
      accessToken: null,
      refreshToken: null,
      secret: null,
      oauthClientSecret: null,
    };
  }
  const [accessToken, refreshToken, secret, oauthClientSecret] =
    await Promise.all([
      dec1(data.accessTokenEnc, keyId, kms),
      dec1(data.refreshTokenEnc, keyId, kms),
      dec1(data.secretEnc, keyId, kms),
      dec1(data.oauthClientSecretEnc, keyId, kms),
    ]);
  return { accessToken, refreshToken, secret, oauthClientSecret };
}
