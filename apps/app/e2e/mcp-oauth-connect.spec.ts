/**
 * mcp-oauth-connect.spec.ts
 *
 * E2E flow 4: Authenticate to an org-enabled OAuth MCP server using the
 * mock OAuth authorization server started by globalSetup.
 *
 * The mock OAuth server returns an instant redirect with `code=e2e_auth_code`.
 * The app's callback handler exchanges it for MOCK_ACCESS_TOKEN. We assert
 * the plugin row shows "connected" status after redirect.
 *
 * Setup:
 *   - seedPlugin creates an org_listings row with auth_kind='oauth' is ideal,
 *     but since our fixture seeds with auth_kind='none', we seed a second
 *     listing with auth_kind='oauth' directly via an extra SQL step.
 *   - The workspace must have the listing enabled at the org level.
 *
 * Testids used (from workspace-integrations-panel.tsx):
 *   plugin-connect-btn-{listing.id}   — wrapper around the OAuth connect button
 *   plugin-auth-status-{listing.id}   — "connected" badge (shown when install exists)
 *   integrations-oauth-btn-{listing.id} — the actual <a> link
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

function uid(): string {
  return randomBytes(4).toString("hex");
}

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

test.describe("mcp-oauth-connect", () => {
  let fixture: PluginFixture;
  /** UUID id of the OAuth org listing — matches listing.id in the UI's data-testid. */
  let oauthListingId: string;
  /** public_id of the OAuth org listing — used for cleanup. */
  let oauthListingPubId: string;

  test.beforeAll(async () => {
    const id = uid();

    // Seed the standard fixture (creates org, user, session, workspace).
    fixture = await seedPlugin({
      orgSlug: `oauth-conn-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-oauth-${id}@oxagen.test`,
      // Use the mock MCP URL for the standard listing; we'll add a separate OAuth listing.
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });

    // Insert an OAuth-kind org listing for the same org pointing at the mock OAuth server.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      oauthListingPubId = `porg_oauth_e2e_${id}`;
      oauthListingId = oauthListingPubId; // will be overwritten below with UUID

      // Insert a custom OAuth-kind org listing (no catalog_server_id — source='custom').
      await sql`
        INSERT INTO plugin.org_listings (
          public_id, org_id, plugin_type, catalog_server_id, source,
          name, title, description, endpoint_url, transport, auth_kind, enabled
        )
        VALUES (
          ${oauthListingPubId},
          ${fixture.orgId},
          'mcp_server',
          null,
          'custom',
          ${"e2e.oauth.mcp." + id},
          'E2E OAuth MCP Server',
          'E2E OAuth fixture server',
          ${process.env.MOCK_OAUTH_ISSUER ?? "http://127.0.0.1:9998"},
          'streamable-http',
          'oauth',
          true
        )
        ON CONFLICT (public_id) DO NOTHING
      `;
      // Fetch the UUID id (needed for data-testid matching in the UI — listing.id is the UUID PK).
      const [oauthListingRow] = await sql<{ id: string }[]>`
        SELECT id FROM plugin.org_listings WHERE public_id = ${oauthListingPubId}
      `;
      if (oauthListingRow) {
        oauthListingId = oauthListingRow.id;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test.afterAll(async () => {
    // Clean up the extra OAuth listing.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await sql`DELETE FROM plugin.org_listings WHERE public_id = ${oauthListingPubId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await fixture.cleanup();
  });

  test("clicking Connect initiates OAuth flow and callback marks server as connected", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // Navigate to workspace integrations.
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/settings/integrations`);
    await expect(page).not.toHaveURL(/\/login/);

    // The OAuth listing row should be visible (listing is enabled at org level).
    const connectWrapper = page.getByTestId(`plugin-connect-btn-${oauthListingId}`);
    await expect(connectWrapper).toBeVisible({ timeout: 10_000 });

    // The OAuth button is inside the wrapper — click it.
    const connectBtn = page.getByTestId(`integrations-oauth-btn-${oauthListingId}`);
    await expect(connectBtn).toBeVisible();

    // The mock OAuth server instantly redirects back with ?code=e2e_auth_code.
    // Playwright follows the redirect chain. We wait for the final URL to be
    // back on the integrations page (without the code param).
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname.includes("/settings/integrations") &&
          !url.searchParams.has("code"),
        { timeout: 20_000 },
      ),
      connectBtn.click(),
    ]);

    // After OAuth callback, a workspace mcp_servers install row should exist
    // and the "connected" badge should appear. If the app's callback handler
    // is wired, the status element will be visible.
    const statusEl = page.getByTestId(`plugin-auth-status-${oauthListingId}`);
    await expect(statusEl).toHaveText(/connected/i, { timeout: 10_000 });
  });
});
