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
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq, sql } from "drizzle-orm";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { schema, withSystemDb } from "@oxagen/database";
import { DbOAuthClientProvider, loadOAuthState, deleteOAuthState } from "@oxagen/plugins";
import { logger } from "@oxagen/handlers/logger";

export const runtime = "nodejs"; // MCP SDK auth uses Node crypto — edge-unsafe.

/**
 * Fetch wrapper for mcpAuth — see authorize/route.ts for full explanation.
 * `cache: "no-store"` bypasses Next's per-URL dedup locks; pre-draining
 * non-OK bodies prevents the patched Response's body.cancel() from hanging.
 */
const safeFetch: FetchLike = async (input, init) => {
  const resp = await fetch(input, { ...init, cache: "no-store" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return new Response(text || null, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  return resp;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "missing code or state" }, { status: 400 });
  }

  // Look up the PKCE/state data saved during the authorize step.
  const stateData = await loadOAuthState(state, Date.now());
  if (!stateData) {
    logger.warn({ state }, "mcp-oauth: callback state expired or not found");
    return NextResponse.json({ error: "state expired or not found" }, { status: 400 });
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
  });

  // Exchange the code for tokens (mcpAuth detects the code and calls the token endpoint).
  // A token-exchange failure must NOT become an unhandled rejection (opaque 500)
  // and must NOT leak the ephemeral PKCE state: catch it, return the same
  // ?mcp=error redirect as the unexpected-REDIRECT path, and clean up state in
  // `finally` so it is deleted on success, failure, AND throw.
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
    return NextResponse.redirect(`${url.origin}${stateData.returnTo}?mcp=error`);
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
          target: [schema.mcpServers.workspaceId, schema.mcpServers.orgListingId],
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

    logger.info({ orgId: stateData.orgId, orgListingId: stateData.orgListingId }, "mcp-oauth: token exchange succeeded, install upserted and marked healthy");
    return NextResponse.redirect(
      `${url.origin}${stateData.returnTo}?mcp=connected`,
    );
  }

  // Unexpected: mcpAuth returned REDIRECT during a callback (shouldn't happen
  // with a valid code, but handle it gracefully).
  logger.warn({ orgId: stateData.orgId, orgListingId: stateData.orgListingId, result }, "mcp-oauth: unexpected REDIRECT result during callback");
  return NextResponse.redirect(
    `${url.origin}${stateData.returnTo}?mcp=error`,
  );
}
