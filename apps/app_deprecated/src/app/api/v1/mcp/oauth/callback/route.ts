/**
 * GET /api/v1/mcp/oauth/callback
 *
 * OAuth 2.1 callback handler: exchanges the authorization code for tokens,
 * stores them encrypted in mcp.credentials, and upserts the workspace install
 * row (creating it if it doesn't exist yet) marked as healthy.
 *
 * Query params: code, state
 * The state parameter is used to look up the PKCE verifier + flow metadata
 * that was saved during the authorize step.
 *
 * No session required — the callback is called by the authorization server,
 * not directly by the user. The state validates the flow.
 */
import { NextResponse, type NextRequest } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq, ne, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import {
  DbOAuthClientProvider,
  loadOAuthState,
  deleteOAuthState,
} from "@oxagen/plugins";
import { isNextRedirectError } from "@/lib/auth-denial";
import { safeFetch } from "@/lib/mcp-oauth/safe-fetch";
import { logger } from "@oxagen/handlers/logger";

// Runs on the default Node.js runtime — MCP SDK auth uses Node crypto, so this
// route must never move to edge. No `export const runtime`: the segment config
// is incompatible with cacheComponents (Node is the framework default).

/**
 * GET wrapper — guarantees the serverless function never crashes with an
 * unhandled exception (FUNCTION_INVOCATION_FAILED / HTTP 502). The pre-token-
 * exchange steps (loadOAuthState, the listing lookup, deleteOAuthState, and the
 * install upsert) each touch the DB and can reject; on a DB outage that would
 * otherwise escape uncaught and 502. We catch it and return a clean 500 JSON,
 * re-throwing only genuine Next redirect sentinels.
 */
/**
 * Builds the back-to-app redirect. `returnTo` is a validated same-origin path
 * saved during the authorize step and may already carry a query string, so
 * flow-result params are appended via URL rather than string concatenation.
 */
function redirectBack(
  origin: string,
  returnTo: string,
  params: Record<string, string>,
): NextResponse {
  const dest = new URL(returnTo, origin);
  for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
  return NextResponse.redirect(dest.toString());
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    return await handleCallback(req);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    // Cache Components: the build-time prerender bails out of this GET by
    // THROWING on the first request-data access (req.url), which happens
    // inside the try above. Rethrow Next-internal errors so the bail-out
    // escapes instead of being logged and baked into static output as a 500.
    unstable_rethrow(err);
    logger.error(
      {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "mcp-oauth: callback handler threw an unhandled error",
    );
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

async function handleCallback(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json(
      { error: "missing code or state" },
      { status: 400 },
    );
  }

  // Look up the PKCE/state data saved during the authorize step.
  const stateData = await loadOAuthState(state, Date.now());
  if (!stateData) {
    logger.warn({ state }, "mcp-oauth: callback state expired or not found");
    return NextResponse.json(
      { error: "state expired or not found" },
      { status: 400 },
    );
  }

  // Verify the listing still exists + get the endpointUrl.
  const listing = await withSystemDb(async (tx) => {
    const [l] = await tx
      .select()
      .from(schema.pluginInstalledPlugins)
      .where(eq(schema.pluginInstalledPlugins.id, stateData.orgListingId))
      .limit(1);
    return l ?? null;
  });

  if (!listing?.endpointUrl) {
    return NextResponse.json({ error: "listing gone" }, { status: 404 });
  }

  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;

  const provider = new DbOAuthClientProvider({
    orgId: stateData.orgId,
    workspaceId: stateData.workspaceId,
    orgListingId: stateData.orgListingId,
    redirectUrl,
    state,
    returnTo: stateData.returnTo,
    clientName: "Oxagen",
    now: () => Date.now(),
    // Token exchange re-reads clientInformation(); for pre-registered
    // (non-DCR) providers the client only exists in env, matched by this URL.
    serverUrl: listing.endpointUrl,
  });

  // Exchange the code for tokens (mcpAuth detects the code and calls the token endpoint).
  // A token-exchange failure must NOT become an unhandled rejection (opaque 500)
  // and must NOT leak the ephemeral PKCE state: catch it, return the same
  // ?mcp=error redirect as the unexpected-REDIRECT path, and delete the state on
  // BOTH legs — in the catch below and immediately after a successful exchange —
  // so a single-use PKCE verifier never survives the attempt that consumed it.
  let result: Awaited<ReturnType<typeof mcpAuth>>;
  try {
    result = await mcpAuth(provider, {
      serverUrl: listing.endpointUrl,
      authorizationCode: code,
      fetchFn: safeFetch,
    });
  } catch (err) {
    await deleteOAuthState(state).catch(() => undefined);
    logger.error(
      {
        orgId: stateData.orgId,
        orgListingId: stateData.orgListingId,
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "mcp-oauth: mcpAuth threw during callback",
    );
    return redirectBack(url.origin, stateData.returnTo, {
      mcp: "error",
      listing: stateData.orgListingId,
    });
  }

  // Clean up the ephemeral state regardless of outcome.
  await deleteOAuthState(state);

  if (result === "AUTHORIZED") {
    // Upsert the workspace install row: create it if it doesn't exist yet
    // (first-time OAuth connect), or update it if it does (reconnect flow).
    // mapAuthStrategy: oauth listings use bearer token auth.
    await withSystemDb(async (tx) => {
      await tx
        .insert(schema.mcpServers)
        .values({
          orgId: stateData.orgId,
          workspaceId: stateData.workspaceId,
          orgListingId: stateData.orgListingId,
          name: listing.name,
          transportType: listing.transport ?? "streamable-http",
          endpointUrl: listing.endpointUrl!,
          authStrategy: "bearer",
          authConfig: {},
          healthStatus: "healthy",
          enabled: true,
          discoveredTools: [],
        })
        .onConflictDoUpdate({
          target: [
            schema.mcpServers.workspaceId,
            schema.mcpServers.orgListingId,
          ],
          // mcp_servers_ws_listing_uniq is a PARTIAL unique index; ON CONFLICT
          // only matches it when the inference clause carries the same predicate.
          targetWhere: sql`org_listing_id IS NOT NULL`,
          set: {
            healthStatus: "healthy",
            enabled: true,
            updatedAt: new Date(),
          },
        });
    });

    // Self-heal the listing's authKind: pre-probe installs (and registry
    // metadata generally) stored OAuth-protected servers as "none"/"secret".
    // Completing the flow is definitive proof the server is OAuth — persist it
    // so the agent runtime takes the token-refreshing OAuth branch and the UI
    // shows the right status. Never blocks the redirect on failure.
    try {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.pluginInstalledPlugins)
          .set({ authKind: "oauth", updatedAt: new Date() })
          .where(
            and(
              eq(schema.pluginInstalledPlugins.id, stateData.orgListingId),
              ne(schema.pluginInstalledPlugins.authKind, "oauth"),
            ),
          );
      });
    } catch (err) {
      logger.error(
        { orgListingId: stateData.orgListingId, err: String(err) },
        "mcp-oauth: authKind self-heal failed (non-fatal)",
      );
    }

    logger.info(
      { orgId: stateData.orgId, orgListingId: stateData.orgListingId },
      "mcp-oauth: token exchange succeeded, install upserted and marked healthy",
    );
    return redirectBack(url.origin, stateData.returnTo, {
      mcp: "connected",
      listing: stateData.orgListingId,
    });
  }

  // Unexpected: mcpAuth returned REDIRECT during a callback (shouldn't happen
  // with a valid code, but handle it gracefully).
  logger.warn(
    { orgId: stateData.orgId, orgListingId: stateData.orgListingId, result },
    "mcp-oauth: unexpected REDIRECT result during callback",
  );
  return redirectBack(url.origin, stateData.returnTo, {
    mcp: "error",
    listing: stateData.orgListingId,
  });
}
