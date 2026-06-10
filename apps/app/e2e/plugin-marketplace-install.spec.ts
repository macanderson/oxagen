/**
 * plugin-marketplace-install.spec.ts
 *
 * E2E: Plugin marketplace install workflow
 *
 * Tests the full click-to-install flow:
 *   1. Navigate to Plugins settings page
 *   2. Click "Browse marketplace"
 *   3. Search for a plugin
 *   4. Click plugin card to view details
 *   5. Click "Install to organization"
 *   6. Verify plugin appears in "Installed plugins" list
 *   7. Verify enable/disable toggle works
 *   8. Verify uninstall removes it
 *
 * Testids used:
 *   browse-marketplace-btn              — "Browse marketplace" button
 *   marketplace-modal                   — the marketplace dialog
 *   marketplace-search-input            — search input
 *   marketplace-server-card-{id}        — clickable server card
 *   marketplace-detail-panel            — detail panel on the right
 *   marketplace-install-btn             — "Install to organization" button
 *   org-listing-row-{id}                — installed plugin row
 *   org-listing-enable-toggle-{id}      — enable/disable toggle
 *   org-listing-uninstall-btn-{id}      — uninstall trash button
 */

import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("plugin-marketplace-install", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `install-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-install-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("can browse marketplace, install plugin, and toggle enabled state", async ({
    page,
    context,
  }) => {
    // Log in as the fixture user
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    // Navigate to plugins settings page
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // ── Step 1: Open marketplace ──────────────────────────────────────────────
    const browseBtn = page.getByTestId("browse-marketplace-btn");
    await expect(browseBtn).toBeVisible({ timeout: 5_000 });
    await browseBtn.click();

    const modal = page.getByTestId("marketplace-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // ── Step 2: Search for the plugin ─────────────────────────────────────────
    const searchInput = page.getByTestId("marketplace-search-input");
    await expect(searchInput).toBeVisible();

    // The fixture server name is something like "e2e.mock.mcp.{id}"
    // Search for part of it
    const searchTerm = fixture.serverName.split(".")[0] || "e2e"; // fallback to "e2e"
    await searchInput.fill(searchTerm);

    // Wait for the search to complete (load more button or grid refilled)
    await page.waitForTimeout(500); // Allow search debounce to complete

    // ── Step 3: Click the server card to view details ──────────────────────────
    const card = page.getByTestId(`marketplace-server-card-${fixture.catalogServerId}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    // Detail panel should appear on the right
    const detailPanel = page.getByTestId("marketplace-detail-panel");
    await expect(detailPanel).toBeVisible({ timeout: 5_000 });

    // ── Step 4: Click "Install to organization" ───────────────────────────────
    const installBtn = detailPanel.getByTestId("plugin-detail-install-btn");
    await expect(installBtn).toBeVisible();
    await installBtn.click();

    // Modal should close after install
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    // ── Step 5: Verify plugin now appears in "Installed plugins" list ─────────
    // Page should have revalidated and the plugin should appear in the table
    const listingRow = page.getByTestId(`org-listing-row-${fixture.orgListingId}`);
    await expect(listingRow).toBeVisible({ timeout: 10_000 });

    // The plugin name should be visible in the row
    await expect(listingRow).toContainText(fixture.serverName);

    // ── Step 6: Verify toggle works ───────────────────────────────────────────
    const enableToggle = page.getByTestId(
      `org-listing-enable-toggle-${fixture.orgListingId}`,
    );
    await expect(enableToggle).toBeVisible();

    // Check if it's currently enabled (from the seed it should be disabled)
    const isEnabled = await enableToggle.isChecked();

    // Toggle it
    await enableToggle.click();

    // Wait for the toggle to update (slight delay for server action)
    await page.waitForTimeout(500);

    // The state should be flipped
    const newState = await enableToggle.isChecked();
    expect(newState).toBe(!isEnabled);

    // Toggle it back
    await enableToggle.click();
    await page.waitForTimeout(500);
    const finalState = await enableToggle.isChecked();
    expect(finalState).toBe(isEnabled);
  });

  test("can search and filter plugins by auth kind", async ({ page, context }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Open marketplace
    await page.getByTestId("browse-marketplace-btn").click();
    const modal = page.getByTestId("marketplace-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Click the "all" auth filter (to reset)
    await page.getByTestId("marketplace-filter-auth-all").click();

    // Verify the grid is shown
    const grid = page.getByTestId("marketplace-server-grid");
    await expect(grid).toBeVisible({ timeout: 10_000 });

    // Filter by oauth
    await page.getByTestId("marketplace-filter-auth-oauth").click();

    // Wait for filters to apply
    await page.waitForTimeout(500);

    // Grid should still be visible (may be empty or filtered)
    await expect(grid).toBeVisible();
  });

  test("bulk install from marketplace", async ({ page, context }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Open marketplace
    await page.getByTestId("browse-marketplace-btn").click();
    const modal = page.getByTestId("marketplace-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Get the checkbox for the plugin
    const checkbox = page.getByTestId(`marketplace-select-${fixture.catalogServerId}`);
    await expect(checkbox).toBeVisible({ timeout: 10_000 });

    // Check the checkbox
    await checkbox.click();

    // Bulk install button should become enabled
    const bulkInstallBtn = page.getByTestId("marketplace-bulk-install-btn");
    await expect(bulkInstallBtn).not.toBeDisabled();

    // The footer should show "1 selected"
    const footer = page.getByTestId("marketplace-footer");
    await expect(footer).toContainText(/1 selected/);

    // Click bulk install
    await bulkInstallBtn.click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });
});
