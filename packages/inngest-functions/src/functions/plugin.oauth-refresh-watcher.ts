/**
 * plugin.oauth-refresh-watcher: proactive OAuth token refresh cron.
 *
 * Runs every REFRESH_INTERVAL_MINUTES. Each run selects the active OAuth
 * credentials that hold a refresh token and expire within
 * REFRESH_WINDOW_MINUTES, on a provider that is still installed and enabled.
 * The window is one interval plus a margin, so a token that expires just
 * before the next run is refreshed on this one.
 *
 * For each credential it builds a DbOAuthClientProvider and calls the MCP SDK
 * auth() with the SSRF-guarded, time-bounded mcpOAuthFetch.
 *
 * Success: auth() returns "AUTHORIZED" after saveTokens() has stored the new
 *   tokens. The credential stays active.
 * Failure: auth() throws, or returns anything but "AUTHORIZED". The SDK
 *   returns "REDIRECT" when it cannot refresh (no refresh token, a rejected
 *   grant, or a refresh error it swallows), which means a person has to
 *   authorize again. markCredentialNeedsReauth() flips the credential to
 *   needs_reauth and emails the org's managers.
 *
 * Before marking, the watcher reads the credential again. If its expiry
 * changed or it is no longer active, another path (the runtime's reactive
 * refresh, or an admin) already handled it, and the watcher leaves it alone.
 * That covers a refresh-token rotation race: the runtime refreshes first, the
 * provider rejects the watcher's now-stale refresh token, and the watcher
 * must not undo a good credential.
 *
 * Each credential is processed in its own step.run() for isolation.
 *
 * CAVEAT: a transient network error or a provider 5xx also ends in
 * needs_reauth. The SDK turns a refresh error it does not recognize into
 * "REDIRECT", so this watcher cannot tell transient from permanent the way
 * ingestion.oauth-refresh does. A flaky provider costs the org a manual
 * re-authorization.
 */
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { mcpOAuthFetch } from "@oxagen/agent/runtime/mcp-oauth-fetch";
import { schema, withSystemDb } from "@oxagen/database";
import {
  DbOAuthClientProvider,
  markCredentialNeedsReauth,
} from "@oxagen/plugins";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/** Minutes between runs. The cron expression is built from this. */
export const REFRESH_INTERVAL_MINUTES = 30;

/** Minutes past one interval that a run still covers, for a late or slow run. */
export const REFRESH_MARGIN_MINUTES = 15;

/** A run refreshes every token that expires within this many minutes. */
export const REFRESH_WINDOW_MINUTES =
  REFRESH_INTERVAL_MINUTES + REFRESH_MARGIN_MINUTES;

type StepDate = Date | string | null;

/** step.run() returns JSON, so a Date comes back as a string. */
function epochOf(value: StepDate | undefined): number | null {
  return value == null ? null : new Date(value).getTime();
}

export const [pluginOauthRefreshWatcher] = createFunction(
  { id: "plugin.oauth-refresh-watcher", retries: 0 },
  { cron: `*/${REFRESH_INTERVAL_MINUTES} * * * *` },
  async ({ step }) => {
    // tenancy: global scheduled sweep across all orgs. Each row carries its
    // orgId and workspaceId, and every later write is scoped to them.
    const expiring = await step.run("load-expiring-credentials", () =>
      withSystemDb((tx) =>
        tx
          .select({
            id: schema.mcpCredentials.id,
            workspaceId: schema.mcpCredentials.workspaceId,
            orgListingId: schema.mcpCredentials.orgListingId,
            orgId: schema.mcpCredentials.orgId,
            expiresAt: schema.mcpCredentials.expiresAt,
            endpointUrl: schema.pluginInstalledPlugins.endpointUrl,
          })
          .from(schema.mcpCredentials)
          .innerJoin(
            schema.pluginInstalledPlugins,
            eq(
              schema.mcpCredentials.orgListingId,
              schema.pluginInstalledPlugins.id,
            ),
          )
          .where(
            and(
              eq(schema.mcpCredentials.authKind, "oauth"),
              eq(schema.mcpCredentials.status, "active"),
              // A row with no refresh token can never refresh here.
              isNotNull(schema.mcpCredentials.refreshTokenEnc),
              lt(
                schema.mcpCredentials.expiresAt,
                // A module constant, so sql.raw carries no caller input.
                sql.raw(`now() + interval '${REFRESH_WINDOW_MINUTES} minutes'`),
              ),
              // A removed or disabled provider is not refreshed, and its
              // managers are not emailed about it.
              isNull(schema.pluginInstalledPlugins.deletedAt),
              eq(schema.pluginInstalledPlugins.enabled, true),
            ),
          ),
      ),
    );

    logger.info(
      { count: expiring.length, windowMinutes: REFRESH_WINDOW_MINUTES },
      "plugin.oauth-refresh-watcher: expiring credentials found",
    );

    let refreshed = 0;
    let markedReauth = 0;
    let handledElsewhere = 0;

    for (const cred of expiring) {
      const endpointUrl = cred.endpointUrl;
      const orgListingId = cred.orgListingId;
      if (!endpointUrl || !orgListingId) continue;

      const result = await step.run(`refresh-${cred.id}`, async () => {
        let failure: unknown;
        try {
          const provider = new DbOAuthClientProvider({
            orgId: cred.orgId,
            workspaceId: cred.workspaceId,
            orgListingId,
            // A refresh opens no browser, so redirectUrl goes unused. The
            // provider interface requires it.
            redirectUrl:
              (process.env.APP_URL ?? "") + "/api/v1/mcp/oauth/callback",
            // A stable state key. A refresh starts no PKCE flow.
            state: "refresh:" + orgListingId,
            returnTo: "",
            clientName: "Oxagen",
            now: () => Date.now(),
            // Pre-registered-client fallback for non-DCR providers (GitHub).
            serverUrl: endpointUrl,
          });

          // auth() exchanges the stored refresh token and calls saveTokens()
          // on success. It returns "REDIRECT" when it cannot refresh.
          const outcome = await mcpAuth(provider, {
            serverUrl: endpointUrl,
            fetchFn: mcpOAuthFetch,
          });
          if (outcome === "AUTHORIZED") return { kind: "refreshed" } as const;
          failure = `auth() returned ${String(outcome)}`;
        } catch (err) {
          failure = err;
        }

        // tenancy: scheduled re-read of one credential, filtered by its id,
        // orgId, and workspaceId.
        const current = await withSystemDb((tx) =>
          tx
            .select({
              status: schema.mcpCredentials.status,
              expiresAt: schema.mcpCredentials.expiresAt,
            })
            .from(schema.mcpCredentials)
            .where(
              and(
                eq(schema.mcpCredentials.id, cred.id),
                eq(schema.mcpCredentials.orgId, cred.orgId),
                eq(schema.mcpCredentials.workspaceId, cred.workspaceId),
              ),
            ),
        );
        const row = current[0];
        if (
          !row ||
          row.status !== "active" ||
          epochOf(row.expiresAt) !== epochOf(cred.expiresAt)
        ) {
          logger.info(
            { credId: cred.id, orgListingId, err: failure },
            "plugin.oauth-refresh-watcher: refresh failed but the credential changed since it was selected; leaving it",
          );
          return { kind: "handled-elsewhere" } as const;
        }

        logger.warn(
          { credId: cred.id, orgListingId, err: failure },
          "plugin.oauth-refresh-watcher: refresh failed; marking needs_reauth",
        );
        await markCredentialNeedsReauth(cred.workspaceId, orgListingId);
        return { kind: "needs-reauth" } as const;
      });

      if (result.kind === "refreshed") refreshed++;
      else if (result.kind === "needs-reauth") markedReauth++;
      else handledElsewhere++;
    }

    logger.info(
      { total: expiring.length, refreshed, markedReauth, handledElsewhere },
      "plugin.oauth-refresh-watcher complete",
    );

    return { total: expiring.length, refreshed, markedReauth, handledElsewhere };
  },
);
