/**
 * mcp-marketplace-install.spec.ts
 *
 * E2E flow 1: Install MCP from marketplace (single + bulk multi-select).
 *
 * Uses seedPlugin for a pre-seeded catalog entry that points at the
 * mock MCP server started by globalSetup.
 *
 * NOTE: The marketplace modal fetches catalog servers via
 * GET /api/v1/plugin/catalog/browse. In a live dev/test environment the
 * seeded catalog_servers row will appear in the browse results since the
 * API reads from the same DB. The spec asserts on the seeded server card.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

// ── Single install ─────────────────────────────────────────────────────────────

test.describe("mcp-marketplace-install — single install", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `mkt-single-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mkt-s-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("open marketplace, select server, click Install — org listing becomes enabled", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Open marketplace dialog.
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-modal")).toBeVisible();

    // Ensure the MCP Servers tab is active.
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Find the fixture server card by its seeded catalogServerId.
    const card = page.getByTestId(`marketplace-server-card-${fixture.catalogServerId}`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Click through to detail and install.
    await card.click();
    await expect(page.getByTestId("marketplace-detail-panel")).toBeVisible();
    await page.getByTestId("plugin-detail-install-btn").click();

    // Dialog closes after successful install.
    await expect(page.getByTestId("marketplace-modal")).not.toBeVisible({ timeout: 15_000 });

    // The server now appears in the org allow-list.
    await expect(page.getByTestId(`org-listing-row-${fixture.orgListingId}`)).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ── Bulk multi-select install ──────────────────────────────────────────────────

test.describe("mcp-marketplace-install — bulk multi-select", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `mkt-bulk-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mkt-b-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("multi-select checkbox + Install selected (n) installs server", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-modal")).toBeVisible();
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Wait for the server grid to load the fixture card.
    await expect(page.getByTestId(`marketplace-server-card-${fixture.catalogServerId}`)).toBeVisible({
      timeout: 15_000,
    });

    // Check the fixture server's checkbox (marketplace-select-{id}).
    const checkbox = page.getByTestId(`marketplace-select-${fixture.catalogServerId}`);
    await checkbox.check();

    // Bulk install button shows count ≥ 1.
    const bulkBtn = page.getByTestId("marketplace-bulk-install-btn");
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toContainText("1");
    await bulkBtn.click();

    // Dialog closes after bulk install.
    await expect(page.getByTestId("marketplace-modal")).not.toBeVisible({ timeout: 15_000 });

    // Server appears in org allow-list.
    await expect(page.getByTestId(`org-listing-row-${fixture.orgListingId}`)).toBeVisible({
      timeout: 10_000,
    });
  });
});
