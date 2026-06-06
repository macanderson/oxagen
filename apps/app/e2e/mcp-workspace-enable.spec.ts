/**
 * mcp-workspace-enable.spec.ts
 *
 * E2E flow 3: Enable a pre-installed (org-allowed, disabled) MCP server
 * at the workspace layer.
 *
 * seedPlugin seeds the org with an org_listings row (enabled=false) and
 * an agent.mcp_servers row. The spec:
 *   1. Enables the listing at the org layer so it appears in the workspace panel.
 *   2. Navigates to the workspace integrations page.
 *   3. Toggles the MCP server on.
 *   4. Asserts the toggle reflects the enabled state.
 *
 * Testids used (from workspace-integrations-panel.tsx):
 *   integrations-row-{listing.id}    — the table row
 *   integrations-toggle-{listing.id} — the enable/disable Switch
 *
 * Testids used (from org-plugins-panel.tsx):
 *   org-listing-enable-toggle-{listing.id} — org-level enable Switch
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("mcp-workspace-enable", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `ws-enable-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-ws-en-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("workspace owner can enable an org-allowed MCP server for this workspace", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // Step 1: Enable the org listing at the org layer first.
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    const orgToggle = page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`);
    await expect(orgToggle).toBeVisible({ timeout: 10_000 });
    // The fixture seeds as disabled=false; click to enable.
    await orgToggle.click();
    // After clicking, the toggle should reflect "checked" state.
    await expect(orgToggle).toHaveAttribute("data-state", "checked", { timeout: 10_000 });

    // Step 2: Navigate to the workspace integrations page.
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/settings/integrations`);
    await expect(page).not.toHaveURL(/\/login/);

    // The seeded server should be visible in the integrations table.
    const row = page.getByTestId(`integrations-row-${fixture.orgListingId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Step 3: Toggle the workspace enable switch on.
    const toggle = page.getByTestId(`integrations-toggle-${fixture.orgListingId}`);
    await toggle.click();

    // Step 4: The toggle should now reflect enabled state.
    await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 10_000 });
  });
});
