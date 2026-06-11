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
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { DbOAuthClientProvider, loadOAuthState, deleteOAuthState } from "@oxagen/plugins";
import { logger } from "@oxagen/handlers/logger";

export const runtime = "nodejs"; // MCP SDK auth uses Node crypto — edge-unsafe.

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
      .from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, stateData.orgListingId))
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
  const result = await mcpAuth(provider, {
    serverUrl: listing.endpointUrl,
    authorizationCode: code,
  });

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
