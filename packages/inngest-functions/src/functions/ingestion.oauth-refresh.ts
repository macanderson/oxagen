import { createFunction } from "../create-function";
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

// ── Provider response shapes ──────────────────────────────────────────────────

interface TokenResponse {
  /** New access token (required on success). */
  accessToken: string;
  /** New refresh token (optional — provider may or may not rotate). */
  refreshToken?: string;
  /** Token lifetime in seconds (optional). */
  expiresInSec?: number;
}

// ── Provider strategy table ───────────────────────────────────────────────────

/**
 * Describes how to refresh an OAuth access token for a specific provider.
 *
 * The shared plumbing (decrypt → HTTP POST → re-encrypt → DB update) is
 * provider-agnostic; only the token endpoint URL, request body construction,
 * required env vars, and response parsing differ per provider.
 */
interface ProviderRefreshStrategy {
  /** Full token-endpoint URL (POST target). */
  tokenUrl: string;
  /**
   * Build the URLSearchParams body for the token request.
   * Returns null if required env vars are absent (skip with a warning).
   */
  buildBody(
    refreshToken: string,
    env: Record<string, string | undefined>,
  ): URLSearchParams | null;
  /** Which env vars must be present (checked before buildBody is called). */
  requiredEnv: readonly string[];
  /**
   * Extra request headers beyond Content-Type + Accept JSON (e.g. Authorization
   * for Basic-auth providers like Zoom).
   */
  extraHeaders?(env: Record<string, string | undefined>): Record<string, string>;
  /**
   * Parse the JSON response into a normalized shape.
   * Throws an object with { error: string } if the provider signals failure.
   */
  parseResponse(
    json: Record<string, unknown>,
  ): TokenResponse | { error: string; description?: string };
  /**
   * Whether this provider's tokens can be refreshed at all.
   * false = "no-refresh provider" — the cron skips them with a clear log instead of
   * a silent skip.  Defaults to true.
   */
  supportsRefresh?: boolean;
}

type ParseResult = TokenResponse | { error: string; description?: string };

function isErrorResult(r: ParseResult): r is { error: string; description?: string } {
  return "error" in r;
}

/**
 * PERMANENT_ERRORS — a set of OAuth error codes that indicate the refresh token
 * has been permanently revoked or invalidated, not just a transient network
 * problem.  When a provider returns one of these the caller marks the
 * source_connection as 'error' so the UI can prompt the user to reconnect.
 */
const PERMANENT_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "token_expired",
  "revoked_token",
  "refresh_token_not_found",
]);

/**
 * Per-provider OAuth refresh strategy table.
 *
 * Env var references:
 *   GitHub  — GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET (the GitHub App
 *             OAuth client, already in use for connector ingestion)
 *   Google  — GOOGLE_DATA_CLIENT_ID / GOOGLE_DATA_CLIENT_SECRET
 *   Slack   — SLACK_DATA_CLIENT_ID / SLACK_DATA_CLIENT_SECRET
 *   Zoom    — ZOOM_DATA_CLIENT_ID / ZOOM_DATA_CLIENT_SECRET
 *   Linear  — no refresh endpoint (access tokens are long-lived PATs)
 *   Salesforce — SALESFORCE_DATA_CLIENT_ID / SALESFORCE_DATA_CLIENT_SECRET
 *   Microsoft  — MICROSOFT_DATA_CLIENT_ID / MICROSOFT_DATA_CLIENT_SECRET
 */
const REFRESH_PROVIDERS: Record<string, ProviderRefreshStrategy> = {
  github: {
    tokenUrl: "https://github.com/login/oauth/access_token",
    requiredEnv: ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["GITHUB_APP_CLIENT_ID"];
      const clientSecret = env["GITHUB_APP_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    },
    parseResponse(json) {
      const j = json as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return { error: j.error ?? "missing_access_token", description: j.error_description };
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresInSec: j.expires_in,
      };
    },
  },

  google: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    requiredEnv: ["GOOGLE_DATA_CLIENT_ID", "GOOGLE_DATA_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["GOOGLE_DATA_CLIENT_ID"];
      const clientSecret = env["GOOGLE_DATA_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    },
    parseResponse(json) {
      const j = json as {
        access_token?: string;
        // Google does NOT rotate the refresh token on refresh — the original
        // stays valid.  The response will not include refresh_token.
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return { error: j.error ?? "missing_access_token", description: j.error_description };
      }
      return {
        accessToken: j.access_token,
        // Google does not return a new refresh_token — intentionally omitted
        expiresInSec: j.expires_in,
      };
    },
  },

  slack: {
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    requiredEnv: ["SLACK_DATA_CLIENT_ID", "SLACK_DATA_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["SLACK_DATA_CLIENT_ID"];
      const clientSecret = env["SLACK_DATA_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      // Slack token rotation: POST grant_type=refresh_token with the refresh
      // token.  Token rotation MUST be enabled in the Slack app settings.
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    },
    parseResponse(json) {
      const j = json as {
        // Slack returns ok:false instead of an HTTP error status on failure.
        ok?: boolean;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!j.ok || !j.access_token) {
        return { error: j.error ?? "slack_refresh_failed" };
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresInSec: j.expires_in,
      };
    },
  },

  zoom: {
    tokenUrl: "https://zoom.us/oauth/token",
    requiredEnv: ["ZOOM_DATA_CLIENT_ID", "ZOOM_DATA_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["ZOOM_DATA_CLIENT_ID"];
      const clientSecret = env["ZOOM_DATA_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      // Zoom uses grant_type=refresh_token in the body (Basic auth in headers).
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    },
    extraHeaders(env) {
      // Zoom requires HTTP Basic auth with the client_id:client_secret pair
      // (base64-encoded).  The body carries only the grant type + refresh token.
      const clientId = env["ZOOM_DATA_CLIENT_ID"] ?? "";
      const clientSecret = env["ZOOM_DATA_CLIENT_SECRET"] ?? "";
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      return { Authorization: `Basic ${credentials}` };
    },
    parseResponse(json) {
      const j = json as {
        access_token?: string;
        // Zoom DOES rotate the refresh token on each use.
        refresh_token?: string;
        expires_in?: number;
        reason?: string;
      };
      if (!j.access_token) {
        return { error: j.reason ?? "missing_access_token" };
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresInSec: j.expires_in,
      };
    },
  },

  /**
   * Linear — no refresh endpoint.
   *
   * Linear access tokens are long-lived personal access tokens (PATs) and do
   * not expire; the OAuth spec does not define a refresh_token flow for them.
   * The cron skips Linear accounts rather than attempting an invalid refresh.
   */
  linear: {
    tokenUrl: "",
    requiredEnv: [],
    buildBody: () => null,
    parseResponse: () => ({ error: "no_refresh_endpoint" }),
    supportsRefresh: false,
  },

  salesforce: {
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    requiredEnv: ["SALESFORCE_DATA_CLIENT_ID", "SALESFORCE_DATA_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["SALESFORCE_DATA_CLIENT_ID"];
      const clientSecret = env["SALESFORCE_DATA_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    },
    parseResponse(json) {
      const j = json as {
        access_token?: string;
        // Salesforce does NOT rotate the refresh token.
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return { error: j.error ?? "missing_access_token", description: j.error_description };
      }
      return {
        accessToken: j.access_token,
        // Salesforce does not return a new refresh_token
        expiresInSec: j.expires_in,
      };
    },
  },

  microsoft: {
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    requiredEnv: ["MICROSOFT_DATA_CLIENT_ID", "MICROSOFT_DATA_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["MICROSOFT_DATA_CLIENT_ID"];
      const clientSecret = env["MICROSOFT_DATA_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        // The scope must mirror the original authorization scope.  Microsoft
        // requires offline_access to receive a refresh token at all; including it
        // here ensures the new token retains the same consent grant.
        scope: "offline_access https://graph.microsoft.com/.default",
      });
    },
    parseResponse(json) {
      const j = json as {
        access_token?: string;
        // Microsoft may or may not rotate the refresh token depending on tenant
        // policy (sliding-window refresh tokens).  Accept it when present.
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return { error: j.error ?? "missing_access_token", description: j.error_description };
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresInSec: j.expires_in,
      };
    },
  },
};

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
 * Error handling: a failure to refresh one token increments refresh_failure_count
 * and logs a warning, but does NOT throw — the cron job continues to the next token.
 * Permanent failures (invalid_grant / revoked) also mark linked source_connections
 * as status='error' so the UI can prompt the user to reconnect.
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
    const cryptoAdapter = createIngestionCryptoAdapter();

    for (const account of expiringAccounts) {
      await step.run(`refresh-token-${account.id}`, async () => {
        if (!account.refresh_token_enc) return;

        const strategy = REFRESH_PROVIDERS[account.provider];

        // ── No-refresh provider (e.g. Linear) ───────────────────────────────
        if (strategy && strategy.supportsRefresh === false) {
          logger.info(
            { tokenId: account.id, provider: account.provider },
            "ingestion-oauth-refresh: provider does not support token refresh (long-lived token) — skipping",
          );
          return;
        }

        // ── Unknown provider ─────────────────────────────────────────────────
        if (!strategy) {
          logger.info(
            { tokenId: account.id, provider: account.provider },
            "ingestion-oauth-refresh: provider refresh not yet implemented — skipping",
          );
          return;
        }

        // ── Decrypt the refresh token ────────────────────────────────────────
        const envelope = account.refresh_token_enc;
        const cipherBuf = Buffer.from(envelope.ciphertext, "base64");

        let decryptedRefreshToken: string;
        try {
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
          await recordRefreshFailure(account.id, false);
          return;
        }

        // ── Load required env vars ───────────────────────────────────────────
        let env: Record<string, string | undefined> = {};
        if (strategy.requiredEnv.length > 0) {
          try {
            // requireEnv validates the vars are present per the baseEnvSchema;
            // cast to the wider record type so strategy helpers can index freely.
            // Double-cast through unknown because baseEnvSchema includes numeric
            // fields (e.g. SMTP_PORT) so the direct cast to Record<string, string?>
            // would be a type-level overlap error.
            env = requireEnv(
              strategy.requiredEnv as Parameters<typeof requireEnv>[0],
            ) as unknown as Record<string, string | undefined>;
          } catch {
            logger.warn(
              { tokenId: account.id, provider: account.provider, requiredEnv: strategy.requiredEnv },
              "ingestion-oauth-refresh: provider OAuth client env vars not configured — skipping",
            );
            return;
          }
        }

        // ── Build the request body ───────────────────────────────────────────
        const body = strategy.buildBody(decryptedRefreshToken, env);
        if (!body) {
          logger.warn(
            { tokenId: account.id, provider: account.provider },
            "ingestion-oauth-refresh: provider OAuth client env vars missing from body builder — skipping",
          );
          return;
        }

        // ── Call the token endpoint ──────────────────────────────────────────
        let responseJson: Record<string, unknown>;
        try {
          const extraHeaders = strategy.extraHeaders ? strategy.extraHeaders(env) : {};
          const response = await fetch(strategy.tokenUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
              ...extraHeaders,
            },
            body,
          });
          responseJson = (await response.json()) as Record<string, unknown>;
        } catch (err) {
          logger.warn(
            { tokenId: account.id, provider: account.provider, err },
            "ingestion-oauth-refresh: token refresh HTTP call failed — incrementing failure count",
          );
          await recordRefreshFailure(account.id, false);
          return;
        }

        // ── Parse the response ───────────────────────────────────────────────
        const parsed = strategy.parseResponse(responseJson);

        if (isErrorResult(parsed)) {
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
        const newAccessCipher = await encrypt(parsed.accessToken, cryptoAdapter.keyId, {
          adapter: cryptoAdapter.adapter,
        });
        const newAccessEnc = {
          keyId: cryptoAdapter.keyId,
          ciphertext: newAccessCipher.toString("base64"),
        };

        // ── Re-encrypt the new refresh token (when rotated) ──────────────────
        let newRefreshEnc: { keyId: string; ciphertext: string } | null = null;
        if (parsed.refreshToken) {
          const newRefreshCipher = await encrypt(parsed.refreshToken, cryptoAdapter.keyId, {
            adapter: cryptoAdapter.adapter,
          });
          newRefreshEnc = {
            keyId: cryptoAdapter.keyId,
            ciphertext: newRefreshCipher.toString("base64"),
          };
        }

        const newExpiresAt =
          parsed.expiresInSec ? new Date(Date.now() + parsed.expiresInSec * 1000) : null;

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
