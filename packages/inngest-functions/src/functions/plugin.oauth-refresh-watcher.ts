/**
 * plugin.oauth-refresh-watcher — proactive OAuth token refresh cron.
 *
 * Runs every 30 minutes. Scans mcp.credentials for OAuth tokens that are
 * active but expiring within 10 minutes, joins pluginOrgListings for the
 * endpointUrl, then attempts a refresh by constructing a DbOAuthClientProvider
 * and calling the MCP SDK auth() function.
 *
 * On refresh success: tokens are saved (saveTokens) and the credential stays active.
 * On refresh failure: markCredentialNeedsReauth() flips the credential to
 *   needs_reauth, which the org admin must clear by re-authorizing.
 *
 * Each credential is processed in its own step.run() for isolation.
 *
 * CAVEAT: any thrown error — including a transient network blip or a provider
 * 5xx — marks the credential needs_reauth. There is no transient-vs-permanent
 * split here the way ingestion.oauth-refresh has one, so a flaky provider costs
 * the org a manual re-authorization.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { schema, withSystemDb } from "@oxagen/database";
import {
  DbOAuthClientProvider,
  markCredentialNeedsReauth,
} from "@oxagen/plugins";
import { createFunction } from "../create-function";
import { logger } from "../logger";

export const [pluginOauthRefreshWatcher] = createFunction(
  { id: "plugin.oauth-refresh-watcher", retries: 0 },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    // Fetch all active OAuth credentials that expire within 10 minutes.
    const expiring = await step.run("load-expiring-credentials", () =>
      withSystemDb((tx) =>
        tx
          .select({
            id: schema.mcpCredentials.id,
            workspaceId: schema.mcpCredentials.workspaceId,
            orgListingId: schema.mcpCredentials.orgListingId,
            orgId: schema.mcpCredentials.orgId,
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
              // expiresAt < now() + 10 minutes
              lt(
                schema.mcpCredentials.expiresAt,
                sql`now() + interval '10 minutes'`,
              ),
            ),
          ),
      ),
    );

    logger.info(
      { count: expiring.length },
      "plugin.oauth-refresh-watcher: expiring credentials found",
    );

    let refreshed = 0;
    let markedReauth = 0;

    for (const cred of expiring) {
      if (!cred.endpointUrl || !cred.orgListingId) continue;

      const result = await step.run(`refresh-${cred.id}`, async () => {
        try {
          const endpointUrl = cred.endpointUrl;
          if (!endpointUrl) throw new Error("missing endpointUrl");

          const provider = new DbOAuthClientProvider({
            orgId: cred.orgId,
            workspaceId: cred.workspaceId,
            orgListingId: cred.orgListingId!,
            // redirectUrl is unused during a refresh (no browser redirect happens)
            // but required by the provider interface.
            redirectUrl:
              (process.env.APP_URL ?? "") + "/api/v1/mcp/oauth/callback",
            // Stable state key — not a fresh PKCE flow.
            state: "refresh:" + cred.orgListingId,
            returnTo: "",
            clientName: "Oxagen",
            now: () => Date.now(),
            // Pre-registered-client fallback for non-DCR providers (GitHub).
            serverUrl: endpointUrl,
          });

          // auth() will detect an existing refresh_token and exchange it for a
          // new access_token, calling saveTokens() on success.
          await mcpAuth(provider, { serverUrl: endpointUrl });
          return { ok: true } as const;
        } catch (err) {
          logger.warn(
            { credId: cred.id, orgListingId: cred.orgListingId, err },
            "plugin.oauth-refresh-watcher: refresh failed; marking needs_reauth",
          );
          await markCredentialNeedsReauth(cred.workspaceId, cred.orgListingId!);
          return { ok: false } as const;
        }
      });

      if (result.ok) {
        refreshed++;
      } else {
        markedReauth++;
      }
    }

    logger.info(
      { total: expiring.length, refreshed, markedReauth },
      "plugin.oauth-refresh-watcher complete",
    );

    return { total: expiring.length, refreshed, markedReauth };
  },
);
