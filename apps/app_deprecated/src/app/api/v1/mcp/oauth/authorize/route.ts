/**
 * GET /api/v1/mcp/oauth/authorize
 *
 * Starts the OAuth 2.1 authorization flow for an OAuth-protected MCP server.
 * Requires org owner or admin role (MCP connections are administrative).
 *
 * Query params: orgSlug, workspaceSlug, orgListingId
 *
 * On REDIRECT: redirects the browser to the authorization server's authorize URL.
 * On AUTHORIZED (already connected): redirects to the workspace integrations page.
 */
import { NextResponse, type NextRequest } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { randomUUID } from "node:crypto";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import {
  DbOAuthClientProvider,
  resolveEndpointRedirects,
} from "@oxagen/plugins";
import { getSession } from "@/lib/session";
import { resolveReturnTo } from "@/app/api/v1/mcp/oauth/return-to";
import { resolveOrg, assertMcpManager } from "@/lib/resolve-org";
import { authDenialStatus, isNextRedirectError } from "@/lib/auth-denial";
import { safeFetch } from "@/lib/mcp-oauth/safe-fetch";
import { logger } from "@oxagen/handlers/logger";

// Runs on the default Node.js runtime — MCP SDK auth uses Node crypto, so this
// route must never move to edge. No `export const runtime`: the segment config
// is incompatible with cacheComponents (Node is the framework default).

/**
 * GET wrapper — converts every thrown value into a real HTTP Response so the
 * serverless function can NEVER crash with an unhandled exception (which Vercel
 * surfaces as FUNCTION_INVOCATION_FAILED / HTTP 502, with no JSON body).
 *
 * Three thrown shapes are handled here:
 *  - A Next.js access-control fallback (`notFound()` from a resolve-org gate):
 *    Route Handlers have no not-found render boundary, so this would otherwise
 *    escape uncaught and 502. We map it to a clean 4xx JSON (404 = unknown org /
 *    non-manager caller — the deliberate info-hiding status used elsewhere here).
 *  - A Next.js redirect sentinel (`permanentRedirect()` from a stale-slug helper):
 *    re-thrown so Next can turn it into the redirect response.
 *  - Anything else (DB outage, registry/SDK bug, unexpected reject): logged as a
 *    structured error and returned as a clean 500 JSON.
 */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    return await handleAuthorize(req);
  } catch (err) {
    if (isNextRedirectError(err)) {
      // A valid redirect signalled via throw — let Next produce the response.
      throw err;
    }
    const denialStatus = authDenialStatus(err);
    if (denialStatus !== null) {
      // Org/role gate denied (notFound). In a route handler this is not caught
      // by a render boundary, so we answer it ourselves as a handled response.
      return NextResponse.json(
        { error: "not found or not permitted" },
        { status: denialStatus },
      );
    }
    // Cache Components: the build-time prerender bails out of this GET by
    // THROWING on the first request-data access (getSession/req.url), which
    // happens inside the try above. Rethrow Next-internal errors so the
    // bail-out escapes instead of being logged and baked into static output
    // as a 500. (Redirect/notFound sentinels are already handled above.)
    unstable_rethrow(err);
    logger.error(
      {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "mcp-oauth: authorize handler threw an unhandled error",
    );
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * Maps an mcpAuth failure to a short reason code carried back to the UI via
 * ?mcp=error&reason=… — the result toast translates codes into actionable
 * copy (raw error strings never reach the URL).
 */
function classifyAuthError(err: unknown): string {
  const msg = String(err);
  if (msg.includes("does not support dynamic client registration")) {
    return "dcr_unsupported";
  }
  if (msg.includes("Invalid OAuth error response")) return "provider_error";
  return "auth_failed";
}

/** Redirect back to the launching surface with error params for the toast. */
function redirectBackWithError(
  origin: string,
  returnTo: string,
  orgListingId: string,
  reason: string,
): NextResponse {
  const dest = new URL(returnTo, origin);
  dest.searchParams.set("mcp", "error");
  dest.searchParams.set("listing", orgListingId);
  dest.searchParams.set("reason", reason);
  return NextResponse.redirect(dest.toString());
}

async function handleAuthorize(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const orgSlug = url.searchParams.get("orgSlug");
  const workspaceSlug = url.searchParams.get("workspaceSlug");
  const orgListingId = url.searchParams.get("orgListingId");

  if (!orgSlug || !workspaceSlug || !orgListingId) {
    // Missing params means the launcher built a bad URL — there's no valid
    // surface to bounce back to, so return a JSON 400 instead.
    return NextResponse.json(
      { error: "missing params: orgSlug, workspaceSlug, orgListingId" },
      { status: 400 },
    );
  }

  // Resolve the bounce-back target BEFORE any auth/lookup gate. Every failure
  // below is reached by a full-page <a> navigation, so it must redirect the
  // user back to the launching surface with an error the result toast can
  // translate — never strand them on a raw-JSON page. (validated: same-origin
  // path inside this org only); default = Workbench → Agent Tools → MCP Servers.
  const returnTo = resolveReturnTo(
    url.searchParams.get("returnTo"),
    orgSlug,
    workspaceSlug,
  );

  const session = await getSession();
  if (!session?.user) {
    // Not signed in — send to login, then back to the launching surface. A
    // JSON 401 would dead-end a full-page navigation.
    const login = new URL("/login", url.origin);
    login.searchParams.set("next", returnTo);
    return NextResponse.redirect(login.toString());
  }

  logger.info(
    { orgSlug, workspaceSlug, orgListingId },
    "mcp-oauth: authorize flow started",
  );

  // Org resolution + the owner/admin gate both signal denial by THROWING a
  // notFound() sentinel. In a full-page navigation that must land back on the
  // launching surface with an actionable toast (esp. the very common
  // non-manager case), not a 404 JSON page. Catch the denial here and redirect.
  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  try {
    tenant = await resolveOrg(orgSlug);
    // Owner/admin gate — only managers can initiate OAuth flows for an org.
    await assertMcpManager(tenant.id, session.user.id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (authDenialStatus(err) !== null) {
      logger.info(
        { orgSlug, orgListingId, userId: session.user.id },
        "mcp-oauth: authorize denied (unknown org or non-manager)",
      );
      return redirectBackWithError(
        url.origin,
        returnTo,
        orgListingId,
        "not_permitted",
      );
    }
    throw err;
  }

  // Resolve the listing to get the endpointUrl + verify org ownership.
  const listing = await withSystemDb(async (tx) => {
    const [l] = await tx
      .select()
      .from(schema.pluginInstalledPlugins)
      .where(eq(schema.pluginInstalledPlugins.id, orgListingId))
      .limit(1);
    return l ?? null;
  });

  if (!listing || listing.orgId !== tenant.id || !listing.endpointUrl) {
    return redirectBackWithError(
      url.origin,
      returnTo,
      orgListingId,
      "not_found",
    );
  }

  // Resolve workspaceId from (orgId, slug) — scoped to the org to avoid cross-org confusion.
  const workspace = await withSystemDb(async (tx) => {
    const [w] = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, tenant.id),
          eq(schema.workspaces.slug, workspaceSlug),
        ),
      )
      .limit(1);
    return w ?? null;
  });

  if (!workspace) {
    return redirectBackWithError(
      url.origin,
      returnTo,
      orgListingId,
      "not_found",
    );
  }

  const state = randomUUID();
  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;

  // Registry metadata sometimes publishes a vanity URL that 301s to the real
  // MCP endpoint (sh.inference.ac → api.inference.sh/mcp); OAuth discovery
  // against the vanity origin probes the wrong host and fails. Resolve the
  // redirect chain first and self-heal the stored listing so the agent
  // runtime and callback leg use the real endpoint too.
  let endpointUrl = listing.endpointUrl;
  const resolvedUrl = await resolveEndpointRedirects(endpointUrl, {
    fetchFn: safeFetch,
  });
  if (resolvedUrl !== endpointUrl) {
    logger.info(
      { orgId: tenant.id, orgListingId, from: endpointUrl, to: resolvedUrl },
      "mcp-oauth: endpoint redirect resolved, self-healing listing",
    );
    endpointUrl = resolvedUrl;
    try {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.pluginInstalledPlugins)
          .set({ endpointUrl: resolvedUrl, updatedAt: new Date() })
          .where(eq(schema.pluginInstalledPlugins.id, orgListingId));
      });
    } catch (err) {
      logger.error(
        { orgListingId, err: String(err) },
        "mcp-oauth: endpoint self-heal failed (non-fatal)",
      );
    }
  }

  const provider = new DbOAuthClientProvider({
    orgId: tenant.id,
    workspaceId: workspace.id,
    orgListingId,
    redirectUrl,
    state,
    returnTo,
    clientName: "Oxagen",
    now: () => Date.now(),
    // Enables the pre-registered-client fallback for authorization servers
    // without dynamic client registration (GitHub).
    serverUrl: endpointUrl,
  });

  let result: string;
  try {
    result = await mcpAuth(provider, {
      serverUrl: endpointUrl,
      fetchFn: safeFetch,
    });
  } catch (err) {
    logger.error(
      {
        orgId: tenant.id,
        orgListingId,
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "mcp-oauth: mcpAuth threw during authorize",
    );
    const reason = classifyAuthError(err);
    if (reason === "dcr_unsupported") {
      // The end-user toast intentionally omits the remedy (they can't act on
      // it). Log the actionable operator fix here: this provider's host needs a
      // pre-registered OAuth client configured on the platform.
      const host = (() => {
        try {
          return new URL(endpointUrl).host;
        } catch {
          return endpointUrl;
        }
      })();
      logger.error(
        { orgId: tenant.id, orgListingId, host, endpointUrl },
        `mcp-oauth: ${host} does not support dynamic client registration — ` +
          `add "${host}" to MCP_OAUTH_PREREGISTERED_CLIENTS (client_id/secret from an ` +
          `OAuth app whose callback is ${url.origin}/api/v1/mcp/oauth/callback) to enable OAuth sign-in`,
      );
    }
    // This is a full-page navigation — a JSON body would strand the user on a
    // dead error page. Land back on the launching surface with a reason code
    // the result toast can translate into actionable copy.
    return redirectBackWithError(url.origin, returnTo, orgListingId, reason);
  }

  logger.info(
    { orgId: tenant.id, orgListingId, result },
    "mcp-oauth: mcpAuth completed",
  );

  if (result === "AUTHORIZED") {
    // Already connected — redirect straight back.
    logger.info(
      { orgId: tenant.id, orgListingId },
      "mcp-oauth: already authorized, skipping flow",
    );
    const dest = new URL(returnTo, url.origin);
    dest.searchParams.set("mcp", "already-connected");
    dest.searchParams.set("listing", orgListingId);
    return NextResponse.redirect(dest.toString());
  }

  if (!provider.pendingRedirect) {
    logger.error(
      { orgId: tenant.id, orgListingId },
      "mcp-oauth: authorization server did not return a redirect URL",
    );
    return redirectBackWithError(
      url.origin,
      returnTo,
      orgListingId,
      "no_redirect",
    );
  }

  logger.info(
    { orgId: tenant.id, orgListingId },
    "mcp-oauth: redirecting to authorization server",
  );
  return NextResponse.redirect(provider.pendingRedirect.toString());
}
