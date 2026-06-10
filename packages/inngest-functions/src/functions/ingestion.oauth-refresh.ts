import { inngest } from "../inngest";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt, encrypt } from "@oxagen/crypto";
import { requireEnv } from "@oxagen/config";
import { logger } from "../logger";

interface ExpiringAccount extends Record<string, unknown> {
  id: string;
  provider: string;
  // JSONB columns are returned as parsed objects by the pg/drizzle driver
  access_token_enc: { keyId: string; ciphertext: string } | null;
  refresh_token_enc: { keyId: string; ciphertext: string } | null;
  org_id: string;
}

/**
 * Proactive OAuth token refresh cron.
 *
 * Runs every hour. Finds all oauth_accounts tokens expiring within 24 hours
 * and refreshes them so connections never fail mid-sync due to a stale token.
 *
 * Step 1: find-expiring-tokens  query ingestion.oauth_accounts
 * Step 2: refresh-token-{id}    decrypt → call provider API → re-encrypt → update
 *
 * Error handling: a failure to refresh one token increments refresh_failure_count
 * and logs a warning, but does NOT throw — the cron job continues to the next token.
 */
export const ingestionOauthRefresh = inngest.createFunction(
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
    const cryptoAdapter = createIngestionCryptoAdapter();

    for (const account of expiringAccounts) {
      await step.run(`refresh-token-${account.id}`, async () => {
        if (!account.refresh_token_enc) return;

        // Decrypt the refresh token envelope (JSONB column is already a parsed object)
        const envelope = account.refresh_token_enc;
        const cipherBuf = Buffer.from(envelope.ciphertext, "base64");

        let decryptedRefreshToken: string;
        try {
          // decrypt() returns a Buffer; convert to UTF-8 string.
          const decryptedRaw: unknown = await decrypt(cipherBuf, cryptoAdapter.keyId, {
            adapter: cryptoAdapter.adapter,
          });
          decryptedRefreshToken = Buffer.isBuffer(decryptedRaw)
            ? decryptedRaw.toString("utf8")
            : String(decryptedRaw);
        } catch (err) {
          logger.warn(
            { tokenId: account.id, provider: account.provider, err },
            "ingestion-oauth-refresh: failed to decrypt refresh token — skipping",
          );
          await withSystemDb((tx) =>
            tx.execute(sql`
              UPDATE ingestion.oauth_accounts
              SET    refresh_failure_count = refresh_failure_count + 1,
                     updated_at            = NOW()
              WHERE  id = ${account.id}::uuid
            `),
          );
          return;
        }

        if (account.provider === "github") {
          // GitHub token refresh
          let env: { GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_CLIENT_SECRET?: string };
          try {
            env = requireEnv(["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"] as const);
          } catch {
            logger.warn(
              { tokenId: account.id },
              "ingestion-oauth-refresh: GITHUB_APP_CLIENT_ID/SECRET not configured — skipping",
            );
            return;
          }

          if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
            logger.warn(
              { tokenId: account.id },
              "ingestion-oauth-refresh: GitHub App client not configured — skipping",
            );
            return;
          }

          let data: {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
            error?: string;
            error_description?: string;
          };

          try {
            const response = await fetch("https://github.com/login/oauth/access_token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: decryptedRefreshToken,
                client_id: env.GITHUB_APP_CLIENT_ID,
                client_secret: env.GITHUB_APP_CLIENT_SECRET,
              }),
            });

            data = (await response.json()) as typeof data;
          } catch (err) {
            logger.warn(
              { tokenId: account.id, err },
              "ingestion-oauth-refresh: GitHub token refresh HTTP call failed — incrementing failure count",
            );
            await withSystemDb((tx) =>
              tx.execute(sql`
                UPDATE ingestion.oauth_accounts
                SET    refresh_failure_count = refresh_failure_count + 1,
                       updated_at            = NOW()
                WHERE  id = ${account.id}::uuid
              `),
            );
            return;
          }

          if (data.error || !data.access_token) {
            logger.warn(
              {
                tokenId: account.id,
                error: data.error,
                description: data.error_description,
              },
              "ingestion-oauth-refresh: GitHub token refresh returned error — incrementing failure count",
            );
            await withSystemDb((tx) =>
              tx.execute(sql`
                UPDATE ingestion.oauth_accounts
                SET    refresh_failure_count = refresh_failure_count + 1,
                       updated_at            = NOW()
                WHERE  id = ${account.id}::uuid
              `),
            );
            return;
          }

          // Re-encrypt the new access token
          const newAccessCipher = await encrypt(data.access_token, cryptoAdapter.keyId, {
            adapter: cryptoAdapter.adapter,
          });
          const newAccessEnc = {
            keyId: cryptoAdapter.keyId,
            ciphertext: newAccessCipher.toString("base64"),
          };

          // Re-encrypt the new refresh token (if provided; GitHub may rotate it)
          let newRefreshEnc: { keyId: string; ciphertext: string } | null = null;
          if (data.refresh_token) {
            const newRefreshCipher = await encrypt(data.refresh_token, cryptoAdapter.keyId, {
              adapter: cryptoAdapter.adapter,
            });
            newRefreshEnc = {
              keyId: cryptoAdapter.keyId,
              ciphertext: newRefreshCipher.toString("base64"),
            };
          }

          const newExpiresAt =
            data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

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
            { tokenId: account.id, provider: "github" },
            "ingestion-oauth-refresh: GitHub token refreshed successfully",
          );
        } else {
          // Unsupported provider — log and skip (don't throw)
          logger.info(
            { tokenId: account.id, provider: account.provider },
            "ingestion-oauth-refresh: provider refresh not yet implemented — skipping",
          );
        }
      });
    }

    return { checked: expiringAccounts.length };
  },
);
