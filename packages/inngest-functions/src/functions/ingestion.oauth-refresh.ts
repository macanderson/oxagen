import { inngest } from "../inngest";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt as cryptoDecrypt } from "@oxagen/crypto";
import { logger } from "../logger";

interface ExpiringToken extends Record<string, unknown> {
  id: string;
  provider: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  org_id: string;
}

/**
 * Proactive OAuth token refresh cron.
 *
 * Runs every hour. Finds all oauth_accounts tokens expiring within 24 hours
 * and refreshes them so connections never fail mid-sync due to a stale token.
 *
 * Token refresh logic is provider-specific (Google, GitHub, Slack).
 * Until provider OAuth clients are wired (GOOGLE_DATA_CLIENT_ID etc.), this
 * function stubs the refresh step with a log line so the cron still runs
 * and reports metrics without throwing.
 *
 * Step 1: find-expiring-tokens  query ingestion.oauth_accounts
 * Step 2: refresh-token-{id}    decrypt → call provider API → re-encrypt → update
 */
export const ingestionOauthRefresh = inngest.createFunction(
  {
    id: "ingestion-oauth-refresh",
    retries: 2,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    // ── Step 1: Find tokens expiring within 24h ──────────────────────────────
    const expiringTokens = await step.run("find-expiring-tokens", () =>
      withSystemDb(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT id,
                 provider,
                 encrypted_access_token,
                 encrypted_refresh_token,
                 org_id
          FROM   ingestion.oauth_accounts
          WHERE  expires_at IS NOT NULL
          AND    expires_at < NOW() + INTERVAL '24 hours'
          AND    encrypted_refresh_token IS NOT NULL
          ORDER  BY expires_at ASC
          LIMIT  200
        `);
        return Array.from(rows) as ExpiringToken[];
      }),
    );

    logger.info({ count: expiringTokens.length }, "ingestion-oauth-refresh: found expiring tokens");

    // ── Step 2: Refresh each expiring token ──────────────────────────────────
    const cryptoAdapter = createIngestionCryptoAdapter();

    for (const token of expiringTokens) {
      await step.run(`refresh-token-${token.id}`, async () => {
        if (!token.encrypted_refresh_token) return;

        // Decrypt the refresh token.
        // TODO(oauth): implement provider-specific token refresh calls.
        // Until then: decrypt to verify the key works, log, and skip the HTTP call.
        // Provider refresh endpoints:
        //   Google:  POST https://oauth2.googleapis.com/token
        //            body: { grant_type:"refresh_token", refresh_token, client_id, client_secret }
        //   GitHub:  POST https://github.com/login/oauth/access_token
        //            body: { grant_type:"refresh_token", refresh_token, client_id, client_secret }
        //   Slack:   POST https://slack.com/api/oauth.v2.access
        //            body: { grant_type:"refresh_token", refresh_token, client_id, client_secret }
        // Tokens are stored as base64-encoded envelope buffers.
        const buf = Buffer.from(token.encrypted_refresh_token, "base64");
        const _refreshToken = await cryptoDecrypt(buf, cryptoAdapter.keyId, { adapter: cryptoAdapter.adapter });

        // Once the provider clients are wired, replace this block with a real
        // HTTP call, re-encrypt the new access/refresh tokens, then:
        //   await withSystemDb((tx) => tx.execute(sql`
        //     UPDATE ingestion.oauth_accounts
        //     SET    encrypted_access_token  = ${newEncryptedAccess}::jsonb,
        //            encrypted_refresh_token = ${newEncryptedRefresh}::jsonb,
        //            expires_at              = ${newExpiresAt},
        //            updated_at              = NOW()
        //     WHERE  id = ${token.id}::uuid
        //   `));
        logger.info(
          { tokenId: token.id, provider: token.provider },
          "ingestion-oauth-refresh: token refresh deferred (provider client not yet wired)",
        );
      });
    }

    return { checked: expiringTokens.length };
  },
);
