/**
 * seed-plugin.ts — DB helper for plugin E2E tests.
 *
 * seedPlugin: inserts a fresh user+org+workspace+session (same pattern as
 * setupAgentRuntimeFixture), then seeds the plugin tables needed to start a
 * spec mid-flow:
 *   - mcp.registries row (mock registry, org-scoped)
 *   - mcp.catalog_servers row (one mock server entry)
 *   - plugin.org_listings row (pre-installed, disabled — ready to enable)
 *   - agent.mcp_servers row (workspace-enabled — ready for agent integration)
 *
 * All inserts use ON CONFLICT DO NOTHING for idempotency.
 * cleanup() deletes in FK-safe order.
 *
 * Schema reference:
 *   mcp.registries          → packages/database/src/schema/mcp.ts
 *   mcp.catalog_servers     → packages/database/src/schema/mcp.ts
 *   plugin.org_listings     → packages/database/src/schema/plugin.ts
 *   agent.mcp_servers       → packages/database/src/schema/agent.ts
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

function uid(): string {
  return randomBytes(6).toString("hex");
}

export interface PluginFixtureOptions {
  orgSlug: string;
  workspaceSlug: string;
  userEmail: string;
  /** URL of the mock MCP server (e.g. from process.env.MOCK_MCP_URL). */
  mockMcpUrl: string;
}

export interface PluginFixture {
  orgId: string;
  workspaceId: string;
  userId: string;
  sessionToken: string;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * The UUID primary key (`id`) of the seeded plugin.org_listings row.
   * This is the value used in data-testid attributes (the UI uses `listing.id`).
   */
  orgListingId: string;
  /** The UUID primary key (`id`) of the seeded mcp.catalog_servers row. */
  catalogServerId: string;
  cleanup: () => Promise<void>;
}

export async function seedPlugin(opts: PluginFixtureOptions): Promise<PluginFixture> {
  const sql = postgres(DATABASE_URL, { max: 3, prepare: false });

  const id = uid();

  // ── Org ──────────────────────────────────────────────────────────────────────
  const [orgRow] = await sql<{ id: string }[]>`
    INSERT INTO org.organizations (public_id, name, slug, plan_type, status)
    VALUES ('org_e2e_' || ${id}, ${"E2E Plugin " + opts.orgSlug}, ${opts.orgSlug}, 'free', 'active')
    ON CONFLICT (slug) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!orgRow) throw new Error("seedPlugin: org upsert returned no row");
  const orgId = orgRow.id;

  // ── User ─────────────────────────────────────────────────────────────────────
  const [userRow] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
    VALUES ('usr_e2e_' || ${id}, ${opts.userEmail}, 'E2E Plugin', 'active', now())
    ON CONFLICT (email) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!userRow) throw new Error("seedPlugin: user upsert returned no row");
  const userId = userRow.id;

  // ── Workspace ─────────────────────────────────────────────────────────────────
  const [wsRow] = await sql<{ id: string }[]>`
    INSERT INTO workspace.workspaces (public_id, org_id, name, slug)
    VALUES ('wrk_e2e_' || ${id}, ${orgId}, 'Main', ${opts.workspaceSlug})
    ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  if (!wsRow) throw new Error("seedPlugin: workspace upsert returned no row");
  const workspaceId = wsRow.id;

  // ── Memberships ───────────────────────────────────────────────────────────────
  await sql`
    INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
    VALUES ('oru_e2e_' || ${id}, ${orgId}, ${userId}, 'owner', now())
    ON CONFLICT (org_id, user_id) DO NOTHING
  `;
  await sql`
    INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at)
    VALUES ('wsu_e2e_' || ${id}, ${workspaceId}, ${userId}, 'owner', now())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `;

  // ── Session ───────────────────────────────────────────────────────────────────
  const sessionToken = `e2e-plugin-session-${id}`;
  await sql`
    INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
    VALUES (${sessionToken}, ${sessionToken}, ${userId}, now() + interval '1 hour', '127.0.0.1', 'playwright-e2e')
    ON CONFLICT (id) DO NOTHING
  `;

  // ── MCP registry (mock, org-scoped) ─────────────────────────────────────────
  // mcp.registries: (public_id citext, org_id uuid nullable, name text, base_url text, enabled bool, is_default_seed bool)
  const registryPubId = `mreg_e2e_${id}`;
  const [regRow] = await sql<{ id: string }[]>`
    INSERT INTO mcp.registries (public_id, org_id, name, base_url, enabled, is_default_seed)
    VALUES (${registryPubId}, ${orgId}, 'E2E Mock Registry', ${opts.mockMcpUrl}, true, false)
    ON CONFLICT (public_id) DO NOTHING
    RETURNING id
  `;
  // Re-fetch if on-conflict returned nothing.
  const [regFetch] = regRow
    ? [regRow]
    : await sql<{ id: string }[]>`SELECT id FROM mcp.registries WHERE public_id = ${registryPubId}`;
  if (!regFetch) throw new Error("seedPlugin: registry insert returned no row");
  const registryDbId = regFetch.id;

  // ── Catalog server entry ──────────────────────────────────────────────────────
  // mcp.catalog_servers: (public_id, registry_id, name, version, is_latest, title, description,
  //   transport_types text[], auth_kind, categories text[], status, published_at, icons jsonb, ...)
  const catalogPubId = `mcat_e2e_${id}`;
  const serverName = `e2e.mock.mcp.${id}`;
  const remotesJson = JSON.stringify([{ transportType: "streamable-http", url: opts.mockMcpUrl + "/mcp" }]);
  const [catRow] = await sql<{ id: string }[]>`
    INSERT INTO mcp.catalog_servers (
      public_id, registry_id, name, version, is_latest,
      title, description, transport_types, auth_kind,
      categories, status, icons, packages, remotes
    )
    VALUES (
      ${catalogPubId},
      ${registryDbId},
      ${serverName},
      '0.0.1',
      true,
      'E2E Mock MCP Server',
      'Smoke-test fixture MCP server with one tool: e2e_ping.',
      ARRAY['streamable-http'],
      'none',
      ARRAY[]::text[],
      'active',
      '[]'::jsonb,
      '[]'::jsonb,
      ${remotesJson}::jsonb
    )
    ON CONFLICT (public_id) DO NOTHING
    RETURNING id
  `;
  const [catFetch] = catRow
    ? [catRow]
    : await sql<{ id: string }[]>`SELECT id FROM mcp.catalog_servers WHERE public_id = ${catalogPubId}`;
  if (!catFetch) throw new Error("seedPlugin: catalog_server insert returned no row");
  const catalogServerId = catFetch.id;

  // ── Org listing (installed but disabled — tests enable it) ───────────────────
  // plugin.org_listings: (public_id, org_id, plugin_type, catalog_server_id uuid nullable,
  //   source text 'registry'|'custom', name, title, description, icon_url, endpoint_url,
  //   transport, auth_kind, auth_config jsonb, enabled bool, config jsonb)
  const listingPubId = `porg_e2e_${id}`;
  const [listingRow] = await sql<{ id: string }[]>`
    INSERT INTO plugin.org_listings (
      public_id, org_id, plugin_type, catalog_server_id,
      source, name, title, description, endpoint_url, transport,
      auth_kind, enabled
    )
    VALUES (
      ${listingPubId},
      ${orgId},
      'mcp_server',
      ${catalogServerId},
      'registry',
      ${serverName},
      'E2E Mock MCP Server',
      'Smoke-test fixture MCP server.',
      ${opts.mockMcpUrl + "/mcp"},
      'streamable-http',
      'none',
      false
    )
    ON CONFLICT (public_id) DO NOTHING
    RETURNING id
  `;
  const [listingFetch] = listingRow
    ? [listingRow]
    : await sql<{ id: string }[]>`SELECT id FROM plugin.org_listings WHERE public_id = ${listingPubId}`;
  if (!listingFetch) throw new Error("seedPlugin: org_listing insert returned no row");
  const orgListingId = listingFetch.id;

  // ── Workspace MCP server row (enabled — for agent-integration spec) ───────────
  // agent.mcp_servers: (public_id, org_id, workspace_id, org_listing_id uuid,
  //   name, transport_type, endpoint_url, auth_strategy, health_status, enabled)
  const mcpPubId = `mcs_e2e_${id}`;
  await sql`
    INSERT INTO agent.mcp_servers (
      public_id, org_id, workspace_id, org_listing_id, name,
      endpoint_url, transport_type, auth_strategy, enabled, health_status
    )
    VALUES (
      ${mcpPubId},
      ${orgId},
      ${workspaceId},
      ${orgListingId},
      'E2E Mock MCP',
      ${opts.mockMcpUrl + "/mcp"},
      'streamable_http',
      'none',
      true,
      'healthy'
    )
    ON CONFLICT (public_id) DO NOTHING
  `;

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  const cleanup = async (): Promise<void> => {
    const csql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await csql`DELETE FROM agent.mcp_servers WHERE public_id = ${mcpPubId}`;
      await csql`DELETE FROM plugin.org_listings WHERE public_id = ${listingPubId}`;
      await csql`DELETE FROM mcp.catalog_servers WHERE public_id = ${catalogPubId}`;
      await csql`DELETE FROM mcp.registries WHERE public_id = ${registryPubId}`;
      await csql`DELETE FROM auth.sessions WHERE id = ${sessionToken}`;
      await csql`DELETE FROM workspace.workspace_users WHERE workspace_id = ${workspaceId}`;
      await csql`DELETE FROM workspace.workspaces WHERE id = ${workspaceId}`;
      await csql`DELETE FROM org.org_users WHERE org_id = ${orgId}`;
      await csql`DELETE FROM auth.users WHERE id = ${userId}`;
      await csql`DELETE FROM org.organizations WHERE id = ${orgId}`;
    } finally {
      await csql.end({ timeout: 5 });
    }
  };

  await sql.end({ timeout: 5 });

  return {
    orgId,
    workspaceId,
    userId,
    sessionToken,
    orgSlug: opts.orgSlug,
    workspaceSlug: opts.workspaceSlug,
    orgListingId,
    catalogServerId,
    cleanup,
  };
}
