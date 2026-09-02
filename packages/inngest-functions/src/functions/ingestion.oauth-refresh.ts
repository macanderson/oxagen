import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import {
  createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId,
  decrypt,
  encrypt,
} from "@oxagen/crypto";
import { logger } from "../logger";
import {
  REFRESH_PROVIDERS,
  PERMANENT_ERRORS,
  refreshOAuthToken,
  refreshProviderKeyFor,
  isRefreshError,
} from "../lib/oauth-strategies";

interface ExpiringAccount extends Record<string, unknown> {
  id: string;
  provider: string;
  // JSONB columns are returned as parsed objects by the pg/drizzle driver
  access_token_enc: { keyId: string; ciphertext: string } | null;
  refresh_token_enc: { keyId: string; ciphertext: string } | null;
  org_id: string;
}

// ── Shared DB helpers ─────────────────────────────────────────────────────────

/**
 * Increment refresh_failure_count and, when the error is permanent (invalid_grant
 * / revoked), also flip the related source_connection to status='error' so the UI
 * can surface a reconnect prompt.
 */
async function recordRefreshFailure(
  accountId: string,
  isPermanent: boolean,
): Promise<void> {
  await withSystemDb((tx) =>
    tx.execute(sql`
      UPDATE ingestion.oauth_accounts
      SET    refresh_failure_count = refresh_failure_count + 1,
             updated_at            = NOW()
      WHERE  id = ${accountId}::uuid
    `),
  );

  if (isPermanent) {
    // Flip every source_connection linked to this oauth_account to 'error' so
    // the dashboard can show a "reconnect required" badge.
    await withSystemDb((tx) =>
      tx.execute(sql`
        UPDATE ingestion.source_connections
        SET    status        = 'error',
               error_message = 'OAuth refresh token is expired or revoked — reconnect required.',
               updated_at    = NOW()
        WHERE  oauth_account_id = ${accountId}::uuid
          AND  status NOT IN ('deleted', 'deleting')
      `),
    );
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Proactive OAuth token refresh cron.
 *
 * Runs every hour. Finds all oauth_accounts tokens expiring within 24 hours
 * and refreshes them so connections never fail mid-sync due to a stale token.
 *
 * Step 1: find-expiring-tokens  query ingestion.oauth_accounts
 * Step 2: refresh-token-{id}    decrypt → call provider API → re-encrypt → update
 *
 * The provider strategy table + HTTP execution live in ../lib/oauth-strategies
 * (shared with the poll-time credential resolver). Error handling: a failure to
 * refresh one token increments refresh_failure_count and logs a warning, but
 * does NOT throw — the cron continues to the next token. Permanent failures
 * (invalid_grant / revoked) also mark linked source_connections status='error'.
 */
export const [ingestionOauthRefresh] = createFunction(
  {
    id: "ingestion-oauth-refresh",
    retries: 2,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    // ── Step 1: Find tokens expiring within 24h ──────────────────────────────
    const expiringAccounts = await step.run("find-expiring-tokens", () =>
      withSystemDb(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT id,
                 provider,
                 access_token_enc,
                 refresh_token_enc,
                 org_id
          FROM   ingestion.oauth_accounts
          WHERE  expires_at IS NOT NULL
          AND    expires_at < NOW() + INTERVAL '24 hours'
          AND    refresh_token_enc IS NOT NULL
          ORDER  BY expires_at ASC
          LIMIT  200
        `);
        return Array.from(rows) as ExpiringAccount[];
      }),
    );

    logger.info(
      { count: expiringAccounts.length },
      "ingestion-oauth-refresh: found expiring accounts",
    );

    // ── Step 2: Refresh each expiring token ──────────────────────────────────
    // Re-encryption uses the CURRENT provider so refreshed tokens lazily migrate
    // to the active INGESTION_CRYPTO_PROVIDER. Decryption, by contrast, must use
    // the adapter that matches each row's STORED keyId (resolved per-row below).
    const writeAdapter = createIngestionCryptoAdapter();

    for (const account of expiringAccounts) {
      await step.run(`refresh-token-${account.id}`, async () => {
        if (!account.refresh_token_enc) return;

        // Normalize connector-surface slugs (e.g. google-drive/google-gmail) onto
        // their shared OAuth strategy key so Google Workspace connections refresh
        // instead of silently lapsing at token expiry.
        const strategy =
          REFRESH_PROVIDERS[refreshProviderKeyFor(account.provider)];

        // ── No-refresh provider (e.g. Linear) ───────────────────────────────
        if (strategy && strategy.supportsRefresh === false) {
          logger.info(
            { tokenId: account.id, provider: account.provider },
            "ingestion-oauth-refresh: provider does not support token refresh (long-lived token) — skipping",
          );
          return;
        }

        // ── Unknown provider ─────────────────────────────────────────────────
        // WARN (not INFO): a provider with expiring tokens and no refresh strategy
        // is a silent break — the token lapses and the connection dies unnoticed.
        if (!strategy) {
          logger.warn(
            { tokenId: account.id, provider: account.provider },
            "ingestion-oauth-refresh: no refresh strategy for provider — skipping (tokens will lapse at expiry)",
          );
          return;
        }

        // ── Decrypt the refresh token ────────────────────────────────────────
        const envelope = account.refresh_token_enc;
        const cipherBuf = Buffer.from(envelope.ciphertext, "base64");

        let decryptedRefreshToken: string;
        try {
          // Select the adapter by the stored keyId, not the active provider.
          const readAdapter = resolveIngestionCryptoAdapterForKeyId(
            envelope.keyId,
          );
          const decryptedRaw: unknown = await decrypt(
            cipherBuf,
            envelope.keyId,
            {
              adapter: readAdapter.adapter,
            },
          );
          decryptedRefreshToken = Buffer.isBuffer(decryptedRaw)
            ? decryptedRaw.toString("utf8")
            : String(decryptedRaw);
        } catch (err) {
          logger.warn(
            { tokenId: account.id, provider: account.provider, err },
            "ingestion-oauth-refresh: failed to decrypt refresh token — skipping",
          );
          await recordRefreshFailure(account.id, false);
          return;
        }

        // ── Refresh via the shared strategy executor ─────────────────────────
        const parsed = await refreshOAuthToken(
          account.provider,
          decryptedRefreshToken,
        );

        if (isRefreshError(parsed)) {
          // "missing_client_env" / "unsupported_provider" are config gaps, not
          // token revocations — skip without counting a failure.
          if (
            parsed.error === "missing_client_env" ||
            parsed.error === "unsupported_provider"
          ) {
            logger.warn(
              {
                tokenId: account.id,
                provider: account.provider,
                error: parsed.error,
              },
              "ingestion-oauth-refresh: provider OAuth client env vars not configured — skipping",
            );
            return;
          }
          if (parsed.error === "http_error") {
            logger.warn(
              {
                tokenId: account.id,
                provider: account.provider,
                description: parsed.description,
              },
              "ingestion-oauth-refresh: token refresh HTTP call failed — incrementing failure count",
            );
            await recordRefreshFailure(account.id, false);
            return;
          }
          const isPermanent = PERMANENT_ERRORS.has(parsed.error);
          logger.warn(
            {
              tokenId: account.id,
              provider: account.provider,
              error: parsed.error,
              description: parsed.description,
              isPermanent,
            },
            isPermanent
              ? "ingestion-oauth-refresh: token refresh returned permanent error — marking connection error"
              : "ingestion-oauth-refresh: token refresh returned error — incrementing failure count",
          );
          await recordRefreshFailure(account.id, isPermanent);
          return;
        }

        // ── Re-encrypt the new access token ──────────────────────────────────
        const newAccessCipher = await encrypt(
          parsed.accessToken,
          writeAdapter.keyId,
          {
            adapter: writeAdapter.adapter,
          },
        );
        const newAccessEnc = {
          keyId: writeAdapter.keyId,
          ciphertext: newAccessCipher.toString("base64"),
        };

        // ── Re-encrypt the new refresh token (when rotated) ──────────────────
        let newRefreshEnc: { keyId: string; ciphertext: string } | null = null;
        if (parsed.refreshToken) {
          const newRefreshCipher = await encrypt(
            parsed.refreshToken,
            writeAdapter.keyId,
            {
              adapter: writeAdapter.adapter,
            },
          );
          newRefreshEnc = {
            keyId: writeAdapter.keyId,
            ciphertext: newRefreshCipher.toString("base64"),
          };
        }

        const newExpiresAt = parsed.expiresInSec
          ? new Date(Date.now() + parsed.expiresInSec * 1000)
          : null;

        // ── Persist the refreshed tokens ─────────────────────────────────────
        await withSystemDb((tx) =>
          tx.execute(sql`
            UPDATE ingestion.oauth_accounts
            SET    access_token_enc      = ${JSON.stringify(newAccessEnc)}::jsonb,
                   refresh_token_enc     = ${newRefreshEnc ? JSON.stringify(newRefreshEnc) : sql`refresh_token_enc`}::jsonb,
                   expires_at            = ${newExpiresAt ? newExpiresAt.toISOString() : null},
                   last_refreshed_at     = NOW(),
                   refresh_failure_count = 0,
                   updated_at            = NOW()
            WHERE  id = ${account.id}::uuid
          `),
        );

        logger.info(
          { tokenId: account.id, provider: account.provider },
          "ingestion-oauth-refresh: token refreshed successfully",
        );
      });
    }

    return { checked: expiringAccounts.length };
  },
);
