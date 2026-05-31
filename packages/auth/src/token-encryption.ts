/**
 * OXA-1420: OAuth token encryption hooks for better-auth.
 *
 * Provides `databaseHooks` for the `account` model that:
 *   - WRITE: encrypt access_token, refresh_token, id_token into the *_enc
 *     bytea columns before create/update (dual-write — plaintext columns are
 *     also preserved during the EXPAND phase for backward compatibility).
 *   - READ: decrypt the *_enc columns on the way out; fall back to the
 *     plaintext columns if the encrypted columns are absent (transition period
 *     before the backfill job runs).
 *
 * EXPAND PHASE ONLY.  Once the CONTRACT migration drops the plaintext columns,
 * remove the plaintext fallbacks in `decryptAccountTokens` and the dual-write
 * of the plaintext columns in the hooks.
 *
 * NEVER log plaintext token values anywhere in this module.
 */

import { encrypt, decrypt } from "@oxagen/crypto";
import type { KmsAdapter } from "@oxagen/crypto";
import { requireEnv } from "@oxagen/config/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of an Account record that carries token fields.  Better-auth
 * passes the full account object; we only care about these six fields.
 */
interface TokenFields {
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  // Encrypted columns — present after EXPAND migration.
  accessTokenEnc?: Buffer | null;
  refreshTokenEnc?: Buffer | null;
  idTokenEnc?: Buffer | null;
  tokenKmsKeyId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encrypt a single nullable token string.  Returns null if the input is
 * null/undefined (no token to encrypt).
 */
async function encryptToken(
  value: string | null | undefined,
  keyId: string,
  adapter: KmsAdapter,
): Promise<Buffer | null> {
  if (value == null || value === "") return null;
  return encrypt(value, keyId, { adapter });
}

/**
 * Decrypt a single nullable encrypted buffer.  Returns null if there is no
 * encrypted value.
 */
async function decryptToken(
  enc: Buffer | null | undefined,
  keyId: string,
  adapter: KmsAdapter,
): Promise<string | null> {
  if (enc == null) return null;
  const buf = await decrypt(enc, keyId, { adapter });
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt the three token fields of an account record for database storage.
 *
 * Returns a partial record with:
 *   - `accessTokenEnc`, `refreshTokenEnc`, `idTokenEnc`  — encrypted bytea
 *   - `tokenKmsKeyId`                                     — CMK used
 *   - `accessToken`, `refreshToken`, `idToken`            — KEPT (plaintext)
 *     because the columns still exist during the EXPAND phase.
 *
 * When the CONTRACT migration drops the plaintext columns, remove the three
 * plaintext fields from the return value here.
 */
export async function encryptAccountTokens(
  data: TokenFields,
  keyId: string,
  adapter: KmsAdapter,
): Promise<TokenFields> {
  const [accessTokenEnc, refreshTokenEnc, idTokenEnc] = await Promise.all([
    encryptToken(data.accessToken, keyId, adapter),
    encryptToken(data.refreshToken, keyId, adapter),
    encryptToken(data.idToken, keyId, adapter),
  ]);

  return {
    // Dual-write: keep plaintext so existing read paths still work during
    // the transition window.  DROP these three lines in the CONTRACT phase.
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    idToken: data.idToken,
    // Encrypted columns:
    accessTokenEnc,
    refreshTokenEnc,
    idTokenEnc,
    tokenKmsKeyId: keyId,
  };
}

/**
 * Decrypt the token fields of an account record loaded from the database.
 *
 * Prefers the encrypted columns; falls back to the plaintext columns if the
 * encrypted column is null (rows not yet backfilled, or created before
 * OXA-1420 went live).
 *
 * In the CONTRACT phase, remove the fallback branches.
 */
export async function decryptAccountTokens(
  data: TokenFields,
  adapter: KmsAdapter,
): Promise<TokenFields> {
  const keyId = data.tokenKmsKeyId;

  // If there is no KMS key id, the row pre-dates OXA-1420; return as-is with
  // no decryption attempt (plaintext columns are still populated).
  if (!keyId) return data;

  const [accessToken, refreshToken, idToken] = await Promise.all([
    data.accessTokenEnc != null
      ? decryptToken(data.accessTokenEnc, keyId, adapter)
      : (data.accessToken ?? null),
    data.refreshTokenEnc != null
      ? decryptToken(data.refreshTokenEnc, keyId, adapter)
      : (data.refreshToken ?? null),
    data.idTokenEnc != null
      ? decryptToken(data.idTokenEnc, keyId, adapter)
      : (data.idToken ?? null),
  ]);

  return {
    ...data,
    accessToken,
    refreshToken,
    idToken,
  };
}

// ---------------------------------------------------------------------------
// better-auth databaseHooks factory
// ---------------------------------------------------------------------------

/**
 * Build the `databaseHooks.account` object to pass to `betterAuth()`.
 *
 * Usage in auth.ts:
 *
 *   import { buildAccountTokenHooks } from "./token-encryption.js";
 *   ...
 *   databaseHooks: {
 *     account: buildAccountTokenHooks(kmsAdapter),
 *   },
 */
export function buildAccountTokenHooks(adapter: KmsAdapter): {
  create: {
    before: (account: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
  };
  update: {
    before: (account: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
  };
} {
  const env = requireEnv(["AUTH_TOKEN_KMS_KEY_ID"] as const);
  const keyId = env.AUTH_TOKEN_KMS_KEY_ID;

  if (!keyId) {
    throw new Error(
      "[auth/token-encryption] AUTH_TOKEN_KMS_KEY_ID is required when token encryption is enabled.",
    );
  }

  return {
    create: {
      async before(account: Record<string, unknown>) {
        const encrypted = await encryptAccountTokens(account as TokenFields, keyId, adapter);
        return { data: { ...account, ...encrypted } };
      },
    },
    update: {
      async before(account: Record<string, unknown>) {
        // Only encrypt if at least one token field is being updated.
        const hasTokenField =
          "accessToken" in account ||
          "refreshToken" in account ||
          "idToken" in account;
        if (!hasTokenField) return { data: account };
        const encrypted = await encryptAccountTokens(account as TokenFields, keyId, adapter);
        return { data: { ...account, ...encrypted } };
      },
    },
  };
}
