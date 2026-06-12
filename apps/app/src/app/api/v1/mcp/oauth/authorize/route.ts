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
import { logger } from '@oxagen/handlers/logger';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export const runtime = 'nodejs'; // MCP SDK auth uses Node crypto — edge-unsafe.

/**
 * Fetch wrapper for mcpAuth that prevents Next.js's patched global fetch from
 * hanging on response.body?.cancel() for non-OK responses.
 *
 * Next.js wraps Response objects with a custom implementation; calling
 * body.cancel() on a non-2xx response with a streaming body (even an empty
 * one) can block indefinitely. Pre-draining the body for non-OK responses and
 * returning a plain Response with a null body makes cancel() a synchronous
 * no-op.
 */
const safeFetch: FetchLike = async (input, init) => {
  const resp = await fetch(input, init);
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

export async function GET(req: NextRequest) {
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
      .from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, orgListingId))
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
  const returnTo = `/${orgSlug}/${workspaceSlug}/settings/integrations`;

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

  // Next.js patches globalThis.fetch with a caching layer that uses per-URL
  // locks for deduplication. When mcpAuth fires multiple sequential fetches
  // to the same well-known URLs (first a 404 for /oauth-protected-resource,
  // then /oauth-authorization-server), the lock held by the first fetch is
  // not released quickly, and the second fetch deadlocks waiting to acquire
  // the same lock. Passing cache:"no-store" bypasses the lock entirely.
  const uncachedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, cache: 'no-store' });

  let result: string;
  try {
    result = await mcpAuth(provider, {
      serverUrl: listing.endpointUrl,
      fetchFn: uncachedFetch,
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
