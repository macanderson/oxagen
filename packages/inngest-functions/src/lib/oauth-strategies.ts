import { requireEnv } from "@oxagen/config";

/**
 * Shared OAuth token-refresh strategy table + refresh executor.
 *
 * Used by BOTH the proactive refresh cron (ingestion.oauth-refresh, which sweeps
 * tokens expiring within 24h) and the poll-time credential resolver
 * (resolve-connection-auth, which refreshes a token that expired between cron
 * runs just before a sync). Keeping one table means a provider's endpoint,
 * body shape, and rotation behaviour are defined exactly once.
 */

/** Normalized success shape from a provider's token endpoint. */
export interface TokenResponse {
  /** New access token (required on success). */
  accessToken: string;
  /** New refresh token (optional — provider may or may not rotate). */
  refreshToken?: string;
  /** Token lifetime in seconds (optional). */
  expiresInSec?: number;
}

export type RefreshResult =
  | TokenResponse
  | { error: string; description?: string };

export function isRefreshError(
  r: RefreshResult,
): r is { error: string; description?: string } {
  return "error" in r;
}

/**
 * Describes how to refresh an OAuth access token for a specific provider.
 * The shared plumbing (decrypt → HTTP POST → re-encrypt → DB update) is
 * provider-agnostic; only the token endpoint URL, request body construction,
 * required env vars, and response parsing differ per provider.
 */
export interface ProviderRefreshStrategy {
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
  extraHeaders?(
    env: Record<string, string | undefined>,
  ): Record<string, string>;
  /**
   * Parse the JSON response into a normalized shape.
   * Returns { error } if the provider signals failure.
   */
  parseResponse(json: Record<string, unknown>): RefreshResult;
  /**
   * Whether this provider's tokens can be refreshed at all.
   * false = "no-refresh provider" — the caller skips them with a clear log
   * instead of a silent skip. Defaults to true.
   */
  supportsRefresh?: boolean;
}

/**
 * PERMANENT_ERRORS — OAuth error codes that indicate the refresh token has been
 * permanently revoked or invalidated, not just a transient network problem.
 * When a provider returns one the caller marks the source_connection 'error' so
 * the UI can prompt the user to reconnect.
 */
export const PERMANENT_ERRORS = new Set([
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
 *   GitHub  — GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET
 *   Google  — GOOGLE_DATA_CLIENT_ID / GOOGLE_DATA_CLIENT_SECRET
 *   Slack   — SLACK_DATA_CLIENT_ID / SLACK_DATA_CLIENT_SECRET
 *   Zoom    — ZOOM_DATA_CLIENT_ID / ZOOM_DATA_CLIENT_SECRET
 *   Linear  — no refresh endpoint (access tokens are long-lived PATs)
 *   Zendesk — no refresh endpoint (OAuth access tokens do not expire)
 *   Salesforce — SALESFORCE_DATA_CLIENT_ID / SALESFORCE_DATA_CLIENT_SECRET
 *   Microsoft  — MICROSOFT_DATA_CLIENT_ID / MICROSOFT_DATA_CLIENT_SECRET
 */
export const REFRESH_PROVIDERS: Record<string, ProviderRefreshStrategy> = {
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
        return {
          error: j.error ?? "missing_access_token",
          description: j.error_description,
        };
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
      // Google does NOT rotate the refresh token — the original stays valid.
      const j = json as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return {
          error: j.error ?? "missing_access_token",
          description: j.error_description,
        };
      }
      return { accessToken: j.access_token, expiresInSec: j.expires_in };
    },
  },

  slack: {
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    requiredEnv: ["SLACK_DATA_CLIENT_ID", "SLACK_DATA_CLIENT_SECRET"],
    buildBody(refreshToken, env) {
      const clientId = env["SLACK_DATA_CLIENT_ID"];
      const clientSecret = env["SLACK_DATA_CLIENT_SECRET"];
      if (!clientId || !clientSecret) return null;
      // Token rotation MUST be enabled in the Slack app settings.
      return new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    },
    parseResponse(json) {
      // Slack returns ok:false instead of an HTTP error status on failure.
      const j = json as {
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
      // Zoom requires HTTP Basic auth with client_id:client_secret (base64).
      const clientId = env["ZOOM_DATA_CLIENT_ID"] ?? "";
      const clientSecret = env["ZOOM_DATA_CLIENT_SECRET"] ?? "";
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64",
      );
      return { Authorization: `Basic ${credentials}` };
    },
    parseResponse(json) {
      // Zoom DOES rotate the refresh token on each use.
      const j = json as {
        access_token?: string;
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
   * Linear — no refresh endpoint. Linear access tokens are long-lived personal
   * access tokens (PATs) and do not expire; the OAuth spec defines no
   * refresh_token flow for them. Callers skip Linear rather than attempting an
   * invalid refresh.
   */
  linear: {
    tokenUrl: "",
    requiredEnv: [],
    buildBody: () => null,
    parseResponse: () => ({ error: "no_refresh_endpoint" }),
    supportsRefresh: false,
  },

  /**
   * Zendesk — no refresh endpoint. A Zendesk OAuth grant returns an access
   * token that does not expire and no refresh token, so there is nothing to
   * rotate. Declared rather than omitted: an absent entry answers
   * "unsupported_provider", which reads as a misconfiguration, while this says
   * the token is meant to be used as-is.
   */
  zendesk: {
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
      // Salesforce does NOT rotate the refresh token.
      const j = json as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return {
          error: j.error ?? "missing_access_token",
          description: j.error_description,
        };
      }
      return { accessToken: j.access_token, expiresInSec: j.expires_in };
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
        // offline_access is required to receive a refresh token; mirroring the
        // original scope keeps the same consent grant.
        scope: "offline_access https://graph.microsoft.com/.default",
      });
    },
    parseResponse(json) {
      // Microsoft may or may not rotate the refresh token (sliding-window).
      const j = json as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (j.error || !j.access_token) {
        return {
          error: j.error ?? "missing_access_token",
          description: j.error_description,
        };
      }
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresInSec: j.expires_in,
      };
    },
  },
};

/**
 * Resolve a connection's provider slug to its REFRESH_PROVIDERS key. The Google
 * Workspace connectors register per-surface slugs (google-drive, google-gmail,
 * google-calendar, google-contacts, google-meet, google-tasks, google-bigquery)
 * that all authenticate against the single shared Google OAuth strategy. Without
 * this normalization those slugs miss the exact-match lookup and their tokens
 * silently never refresh (breaking the connection at access-token expiry). All
 * other providers pass through unchanged.
 */
export function refreshProviderKeyFor(provider: string): string {
  return provider.startsWith("google-") ? "google" : provider;
}

/**
 * Execute an OAuth refresh for one provider given a decrypted refresh token.
 * Loads the provider's client-credential env vars, POSTs to the token endpoint,
 * and returns the normalized TokenResponse or an { error } result. Never throws
 * for provider/HTTP errors — those come back as { error } so callers can decide
 * whether to increment the failure count or mark the connection errored.
 *
 * Returns { error: "unsupported_provider" | "no_refresh_endpoint" |
 * "missing_client_env" } for the non-refreshable cases so callers can log a
 * precise reason instead of a silent skip.
 */
export async function refreshOAuthToken(
  provider: string,
  refreshToken: string,
): Promise<RefreshResult> {
  const strategy = REFRESH_PROVIDERS[refreshProviderKeyFor(provider)];
  if (!strategy) return { error: "unsupported_provider" };
  if (strategy.supportsRefresh === false)
    return { error: "no_refresh_endpoint" };

  let env: Record<string, string | undefined> = {};
  if (strategy.requiredEnv.length > 0) {
    try {
      env = requireEnv(
        strategy.requiredEnv as Parameters<typeof requireEnv>[0],
      ) as unknown as Record<string, string | undefined>;
    } catch {
      return { error: "missing_client_env" };
    }
  }

  const body = strategy.buildBody(refreshToken, env);
  if (!body) return { error: "missing_client_env" };

  let responseJson: Record<string, unknown>;
  try {
    const extraHeaders = strategy.extraHeaders
      ? strategy.extraHeaders(env)
      : {};
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
    return {
      error: "http_error",
      description: err instanceof Error ? err.message : String(err),
    };
  }

  return strategy.parseResponse(responseJson);
}
