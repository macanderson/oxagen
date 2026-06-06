/**
 * mcp-disable.spec.ts
 *
 * E2E flow 5: Disable a previously-enabled MCP server at the org layer.
 *
 * seedPlugin seeds the org_listings row with enabled=false. The test:
 *   1. Enables the server (toggle click → checked).
 *   2. Disables the server (toggle click → unchecked).
 *   3. Reloads the page to confirm the disabled state is persisted in the DB.
 *
 * Testids used (from org-plugins-panel.tsx):
 *   org-listing-enable-toggle-{listing.id} — the enable/disable Switch per row
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("mcp-disable", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `disable-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-dis-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("owner can disable an enabled MCP server at the org allow-list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    const enableToggle = page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`);
    await expect(enableToggle).toBeVisible({ timeout: 10_000 });

    // Step 1: Enable first (fixture seeds as enabled=false → toggle is unchecked).
    await enableToggle.click();
    await expect(enableToggle).toHaveAttribute("data-state", "checked", { timeout: 10_000 });

    // Step 2: Now disable.
    await enableToggle.click();
    await expect(enableToggle).toHaveAttribute("data-state", "unchecked", { timeout: 10_000 });

    // Step 3: Reload to confirm DB-persisted disabled state.
    await page.reload();
    await expect(
      page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`),
    ).toHaveAttribute("data-state", "unchecked", { timeout: 10_000 });
  });
});
