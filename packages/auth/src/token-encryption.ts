/**
 * OAuth token encryption hooks for better-auth.
 *
 * Provides `databaseHooks` for the `account` model that:
 *   - WRITE: encrypt access_token, refresh_token, id_token into the *_enc
 *     bytea columns before create/update, and strip the plaintext columns.
 *
 * Decryption is NOT wired into databaseHooks. `decryptAccountTokens` is exported
 * for explicit call-site use only (e.g. a DATA-client token-refresh path) — it
 * does not run automatically on Better Auth reads.
 *
 * COLUMN STATE: The plaintext `access_token`, `refresh_token`, and `id_token`
 * columns are STILL PRESENT in the DB (nullable). Better Auth's drizzle adapter
 * writes them directly on some OAuth account create/link paths that bypass
 * this application-layer hook, so the columns can't be dropped without
 * breaking sign-in. The strip hooks here cover the write paths this module
 * sees — the Postgres BEFORE INSERT/UPDATE trigger (migration archive
 * 0003_soc2_auth_hardening.sql) is the backstop that nulls each plaintext
 * column whenever its *_enc counterpart is non-null on ANY write path.
 *
 * ENCRYPTION COVERAGE: All three token fields — access_token, refresh_token,
 * AND id_token — are encrypted into their *_enc counterparts and their
 * plaintext columns are stripped before any write. Double protection:
 *   1. Application hook (this file) strips plaintext on covered write paths.
 *   2. DB trigger (migration archive 0003_soc2_auth_hardening.sql) strips on ANY
 *      write path, including Better Auth internal paths that bypass this hook.
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
 * NOTE: the plaintext `accessToken` / `refreshToken` / `idToken` columns still
 * exist in the DB but this module strips them before write so plaintext is not
 * durably stored once the *_enc counterpart is populated. They may be present on
 * the incoming account object from Better Auth's in-memory representation during
 * the OAuth callback — we read them for encryption purposes only and strip them
 * from the write set.
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
 * The plaintext `access_token` / `refresh_token` / `id_token` columns still
 * exist but are stripped by the caller's stripPlaintextTokens before writing.
 * This function returns ONLY the encrypted columns — it does NOT write back
 * any plaintext value.
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
    // Only the encrypted bytea columns and the KMS key reference — never the
    // plaintext values.
    accessTokenEnc,
    refreshTokenEnc,
    idTokenEnc,
    tokenKmsKeyId: keyId,
  };
}

/**
 * Decrypt the token fields of an account record loaded from the database.
 *
 * This function only reads the *_enc bytea columns (the plaintext columns are
 * stripped on write and must not be trusted). If `tokenKmsKeyId` is absent the
 * row predates encryption and the encrypted tokens are unavailable — returns
 * the record with null token fields.
 */
export async function decryptAccountTokens(
  data: TokenFields,
  adapter: KmsAdapter,
): Promise<TokenFields> {
  const keyId = data.tokenKmsKeyId;

  // No KMS key id means the row predates encryption. The plaintext columns
  // are stripped on write and not trusted, so there is nothing to return for
  // these rows.
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
 * Remove plaintext token fields from an account object before writing.
 * - access_token / refresh_token / id_token: all still columns in the schema
 *   (Better Auth writes/reads them on some paths) but we strip them here so the
 *   plaintext is never durably stored once the encrypted *_enc counterpart
 *   exists. The DB trigger (migration archive 0003_soc2_auth_hardening.sql) is
 *   the final backstop for any write path that bypasses this hook.
 * MUST run on every account write.
 */
function stripPlaintextTokens(
  account: Record<string, unknown>,
): Record<string, unknown> {
  const {
    accessToken: _at,
    refreshToken: _rt,
    idToken: _it,
    ...rest
  } = account;
  void _at;
  void _rt;
  void _it;
  return rest;
}

/**
 * Account hooks for environments WITHOUT an encryption key (local dev / tests).
 * The plaintext token columns must always be stripped or OAuth sign-up fails;
 * without a KMS key the tokens simply aren't persisted (the *_enc columns stay
 * null) but the account + user are still created so social sign-in works.
 */
export function buildStripOnlyAccountHooks(): {
  create: {
    before: (
      a: Record<string, unknown>,
    ) => Promise<{ data: Record<string, unknown> }>;
  };
  update: {
    before: (
      a: Record<string, unknown>,
    ) => Promise<{ data: Record<string, unknown> }>;
  };
} {
  return {
    create: {
      before: async (account) => ({ data: stripPlaintextTokens(account) }),
    },
    update: {
      before: async (account) => ({ data: stripPlaintextTokens(account) }),
    },
  };
}

export function buildAccountTokenHooks(
  adapter: KmsAdapter,
  keyId: string,
): {
  create: {
    before: (
      account: Record<string, unknown>,
    ) => Promise<{ data: Record<string, unknown> }>;
  };
  update: {
    before: (
      account: Record<string, unknown>,
    ) => Promise<{ data: Record<string, unknown> }>;
  };
} {
  if (!keyId) {
    throw new Error(
      "[auth/token-encryption] a key-version label is required when token encryption is enabled.",
    );
  }

  return {
    create: {
      async before(account: Record<string, unknown>) {
        const encrypted = await encryptAccountTokens(
          account as TokenFields,
          keyId,
          adapter,
        );
        // Strip plaintext columns and merge encrypted fields.
        return { data: { ...stripPlaintextTokens(account), ...encrypted } };
      },
    },
    update: {
      async before(account: Record<string, unknown>) {
        // Only encrypt if at least one token field is being updated.
        const hasAccess = "accessToken" in account;
        const hasRefresh = "refreshToken" in account;
        const hasId = "idToken" in account;
        if (!hasAccess && !hasRefresh && !hasId) return { data: account };

        // Encrypt ONLY the token fields actually present in this update payload.
        // A partial update (e.g. the OAuth access-token refresh flow, where
        // Google omits the refresh_token) must NOT emit `*_enc: null` for the
        // untouched fields — Drizzle would write those nulls and overwrite the
        // previously-stored encrypted refresh_token/id_token, permanently
        // breaking future refreshes. The DB trigger only nulls *plaintext*
        // columns; it does not preserve an existing *_enc value.
        const fields = account as TokenFields;
        const [accessTokenEnc, refreshTokenEnc, idTokenEnc] = await Promise.all(
          [
            hasAccess
              ? encryptToken(fields.accessToken, keyId, adapter)
              : Promise.resolve(undefined),
            hasRefresh
              ? encryptToken(fields.refreshToken, keyId, adapter)
              : Promise.resolve(undefined),
            hasId
              ? encryptToken(fields.idToken, keyId, adapter)
              : Promise.resolve(undefined),
          ],
        );

        const encrypted: TokenFields = { tokenKmsKeyId: keyId };
        if (hasAccess) encrypted.accessTokenEnc = accessTokenEnc;
        if (hasRefresh) encrypted.refreshTokenEnc = refreshTokenEnc;
        if (hasId) encrypted.idTokenEnc = idTokenEnc;

        // Strip plaintext columns and merge only the touched encrypted fields.
        return { data: { ...stripPlaintextTokens(account), ...encrypted } };
      },
    },
  };
}
