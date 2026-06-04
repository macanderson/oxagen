/**
 * OXA-1420: OAuth token encryption hooks for better-auth.
 *
 * Provides `databaseHooks` for the `account` model that:
 *   - WRITE: encrypt access_token, refresh_token, id_token into the *_enc
 *     bytea columns before create/update.
 *   - READ: decrypt the *_enc columns on the way out.
 *
 * CONTRACT PHASE: Migration 0012 has dropped the plaintext `access_token` and
 * `refresh_token` columns from the `accounts` table. This module no longer
 * dual-writes plaintext — only the *_enc columns are written.
 *
 * `idToken` (OIDC identity assertion) is still stored in the DB as `id_token`
 * plaintext because it is read-only and not a bearer credential. It is also
 * encrypted into `id_token_enc` for defense-in-depth (both values are written).
 *
 * NEVER log plaintext token values anywhere in this module.
 */

import { encrypt, decrypt } from "@oxagen/crypto";
import type { KmsAdapter } from "@oxagen/crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of an Account record that carries token fields.  Better-auth
 * passes the full account object; we only care about these fields.
 *
 * NOTE: `accessToken` and `refreshToken` plain-text fields are no longer
 * persisted to the DB (dropped by migration 0012 / OXA-1504 CONTRACT phase).
 * They may still be present on the incoming account object from Better Auth's
 * in-memory representation during the OAuth callback — we read them for
 * encryption purposes only and do NOT write them back.
 */
interface TokenFields {
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  // Encrypted columns — written to the DB.
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
 * CONTRACT PHASE (migration 0012): the plaintext `access_token` and
 * `refresh_token` columns have been dropped. This function returns ONLY the
 * encrypted columns — it does NOT write back the plaintext values.
 *
 * Returns a partial record with:
 *   - `accessTokenEnc`, `refreshTokenEnc`, `idTokenEnc`  — encrypted bytea
 *   - `tokenKmsKeyId`                                     — CMK used
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
    // CONTRACT phase: no plaintext columns — return only the encrypted bytea
    // columns and the KMS key reference.
    accessTokenEnc,
    refreshTokenEnc,
    idTokenEnc,
    tokenKmsKeyId: keyId,
  };
}

/**
 * Decrypt the token fields of an account record loaded from the database.
 *
 * CONTRACT PHASE (migration 0012): plaintext `access_token` / `refresh_token`
 * columns no longer exist in the DB. This function only reads the *_enc bytea
 * columns. If `tokenKmsKeyId` is absent the row predates OXA-1420 and the
 * tokens are unavailable — returns the record with null token fields.
 */
export async function decryptAccountTokens(
  data: TokenFields,
  adapter: KmsAdapter,
): Promise<TokenFields> {
  const keyId = data.tokenKmsKeyId;

  // No KMS key id means the row predates OXA-1420 encryption. The plaintext
  // columns have been dropped, so there is nothing to return.
  if (!keyId) {
    return { ...data, accessToken: null, refreshToken: null, idToken: null };
  }

  const [accessToken, refreshToken, idToken] = await Promise.all([
    decryptToken(data.accessTokenEnc, keyId, adapter),
    decryptToken(data.refreshTokenEnc, keyId, adapter),
    decryptToken(data.idTokenEnc, keyId, adapter),
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
 *   import { buildAccountTokenHooks } from "./token-encryption";
 *   ...
 *   databaseHooks: {
 *     account: buildAccountTokenHooks(kmsAdapter),
 *   },
 */

/**
 * Remove plaintext token fields from an account object before writing. Migration
 * 0012 dropped the `access_token` / `refresh_token` columns, so passing them to
 * the Drizzle adapter raises an "unknown column" error and the OAuth account
 * (hence the user) cannot be created. MUST run on every account write.
 */
function stripDroppedTokenColumns(account: Record<string, unknown>): Record<string, unknown> {
  const { accessToken: _at, refreshToken: _rt, ...rest } = account;
  void _at;
  void _rt;
  return rest;
}

/**
 * Account hooks for environments WITHOUT an encryption key (local dev / tests).
 * The dropped plaintext columns must always be stripped or OAuth sign-up fails;
 * without a KMS key the tokens simply aren't persisted (the *_enc columns stay
 * null) but the account + user are still created so social sign-in works.
 */
export function buildStripOnlyAccountHooks(): {
  create: { before: (a: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }> };
  update: { before: (a: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }> };
} {
  return {
    create: { before: async (account) => ({ data: stripDroppedTokenColumns(account) }) },
    update: { before: async (account) => ({ data: stripDroppedTokenColumns(account) }) },
  };
}

export function buildAccountTokenHooks(adapter: KmsAdapter, keyId: string): {
  create: {
    before: (account: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
  };
  update: {
    before: (account: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
  };
} {
  if (!keyId) {
    throw new Error(
      "[auth/token-encryption] a key-version label is required when token encryption is enabled.",
    );
  }

  /**
   * Remove plaintext token fields from the account object before writing to
   * the DB. Migration 0012 dropped `access_token` and `refresh_token` columns;
   * passing them to the adapter would cause an "unknown column" error.
   */
  function stripPlaintextTokens(account: Record<string, unknown>): Record<string, unknown> {
    const { accessToken: _at, refreshToken: _rt, ...rest } = account;
    void _at;
    void _rt;
    return rest;
  }

  return {
    create: {
      async before(account: Record<string, unknown>) {
        const encrypted = await encryptAccountTokens(account as TokenFields, keyId, adapter);
        // Strip plaintext columns (dropped in migration 0012) and merge encrypted fields.
        return { data: { ...stripPlaintextTokens(account), ...encrypted } };
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
        // Strip plaintext columns and merge encrypted fields.
        return { data: { ...stripPlaintextTokens(account), ...encrypted } };
      },
    },
  };
}
