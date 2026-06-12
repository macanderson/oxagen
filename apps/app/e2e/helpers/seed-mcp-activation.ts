/**
 * seed-mcp-activation.ts
 *
 * Extends seedPlugin to produce a fixture suitable for MCP server activation
 * E2E tests. Key differences from seedPlugin:
 *   - org_listings row is seeded with enabled=true (conversation-page query
 *     requires both mcpServers.enabled AND org_listings.enabled to be true)
 *   - Returns mcpPublicId so tests can assert it appears in stream request bodies
 */
import postgres from "postgres";
import { seedPlugin, type PluginFixture, type PluginFixtureOptions } from "./seed-plugin";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

export interface McpActivationFixture extends PluginFixture {
  /** publicId of the seeded mcp.mcp_servers row (e.g. "mcs_e2e_*"). */
  mcpPublicId: string;
}

export async function seedMcpActivation(
  opts: PluginFixtureOptions,
): Promise<McpActivationFixture> {
  const base = await seedPlugin(opts);

  const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
  try {
    // Enable the org listing so the conversation-page server component returns it.
    await sql`
      UPDATE plugin.org_listings
      SET enabled = true
      WHERE id = ${base.orgListingId}
    `;

    // Fetch the mcp_servers publicId for this fixture's workspace.
    const [row] = await sql<{ public_id: string }[]>`
      SELECT public_id FROM mcp.mcp_servers
      WHERE workspace_id = ${base.workspaceId}
        AND enabled = true
      LIMIT 1
    `;
    if (!row) throw new Error("seedMcpActivation: no mcp_servers row found");

    return { ...base, mcpPublicId: row.public_id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
