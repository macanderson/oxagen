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
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { and, eq } from 'drizzle-orm';
import { schema, withSystemDb } from '@oxagen/database';
import { DbOAuthClientProvider } from '@oxagen/plugins';
import { getSession } from '@/lib/session';
import { resolveOrg, assertMcpManager } from '@/lib/resolve-org';
import { authDenialStatus, isNextRedirectError } from '@/lib/auth-denial';
import { logger } from '@oxagen/handlers/logger';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export const runtime = 'nodejs'; // MCP SDK auth uses Node crypto — edge-unsafe.

/**
 * Fetch wrapper for mcpAuth that works around two Next.js patched-fetch
 * behaviours that hang the OAuth discovery sequence:
 *
 * 1. Next's caching layer takes per-URL locks for request deduplication;
 *    mcpAuth's sequential well-known fetches can deadlock on the lock held by
 *    the previous request. `cache: "no-store"` bypasses the lock entirely.
 * 2. Next wraps Response objects; calling body.cancel() on a non-2xx response
 *    (the SDK cancels the 404 from /.well-known/oauth-protected-resource) can
 *    block indefinitely. Pre-draining non-OK bodies and returning a plain
 *    Response makes cancel() a synchronous no-op.
 */
const safeFetch: FetchLike = async (input, init) => {
  const resp = await fetch(input, { ...init, cache: 'no-store' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return new Response(text || null, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  return resp;
};

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
        { error: 'not found or not permitted' },
        { status: denialStatus },
      );
    }
    logger.error(
      {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'mcp-oauth: authorize handler threw an unhandled error',
    );
    return NextResponse.json(
      { error: 'internal error' },
      { status: 500 },
    );
  }
}

async function handleAuthorize(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const orgSlug = url.searchParams.get('orgSlug');
  const workspaceSlug = url.searchParams.get('workspaceSlug');
  const orgListingId = url.searchParams.get('orgListingId');

  if (!orgSlug || !workspaceSlug || !orgListingId) {
    return NextResponse.json(
      { error: 'missing params: orgSlug, workspaceSlug, orgListingId' },
      { status: 400 },
    );
  }

  logger.info(
    { orgSlug, workspaceSlug, orgListingId },
    'mcp-oauth: authorize flow started',
  );

  const tenant = await resolveOrg(orgSlug);

  // Owner/admin gate — only managers can initiate OAuth flows on behalf of an org.
  await assertMcpManager(tenant.id, session.user.id);

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
    return NextResponse.json(
      { error: 'listing not found or not connectable' },
      { status: 404 },
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
    return NextResponse.json({ error: 'workspace not found' }, { status: 404 });
  }

  const state = randomUUID();
  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;
  const returnTo = `/${orgSlug}/${workspaceSlug}/settings/plugins`;

  const provider = new DbOAuthClientProvider({
    orgId: tenant.id,
    workspaceId: workspace.id,
    orgListingId,
    redirectUrl,
    state,
    returnTo,
    clientName: 'Oxagen',
    now: () => Date.now(),
  });

  let result: string;
  try {
    result = await mcpAuth(provider, {
      serverUrl: listing.endpointUrl,
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
      'mcp-oauth: mcpAuth threw during authorize',
    );
    return NextResponse.json(
      { error: 'mcp auth failed', detail: String(err) },
      { status: 502 },
    );
  }

  logger.info(
    { orgId: tenant.id, orgListingId, result },
    'mcp-oauth: mcpAuth completed',
  );

  if (result === 'AUTHORIZED') {
    // Already connected — redirect straight back.
    logger.info(
      { orgId: tenant.id, orgListingId },
      'mcp-oauth: already authorized, skipping flow',
    );
    return NextResponse.redirect(
      `${url.origin}${returnTo}?mcp=already-connected`,
    );
  }

  if (!provider.pendingRedirect) {
    return NextResponse.json(
      { error: 'authorization server did not return a redirect URL' },
      { status: 502 },
    );
  }

  logger.info(
    { orgId: tenant.id, orgListingId },
    'mcp-oauth: redirecting to authorization server',
  );
  return NextResponse.redirect(provider.pendingRedirect.toString());
}
