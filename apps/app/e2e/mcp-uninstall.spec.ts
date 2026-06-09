/**
 * mcp-uninstall.spec.ts
 *
 * E2E flow 6: Remove an MCP server from the org allow-list (uninstall).
 *
 * The uninstall button triggers a window.confirm() dialog (AllowListSection
 * in org-plugins-panel.tsx). Playwright's dialog handler accepts it
 * automatically. After confirmation the server action soft-deletes the
 * org listing and removes dependent workspace installs; the row disappears.
 *
 * Testids used:
 *   org-listing-row-{listing.id}         — the table row per listing
 *   org-listing-uninstall-btn-{listing.id} — the remove/trash button per row
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("mcp-uninstall", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `uninstall-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-uninst-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("owner can remove an MCP server from the org allow-list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // The listing row must be visible.
    await expect(
      page.getByTestId(`org-listing-row-${fixture.orgListingId}`),
    ).toBeVisible({ timeout: 10_000 });

    // Accept the window.confirm() dialog that AllowListSection pops up.
    page.once("dialog", (dialog) => dialog.accept());

    // Click uninstall button.
    await page.getByTestId(`org-listing-uninstall-btn-${fixture.orgListingId}`).click();

    // Row is gone after the server action completes.
    await expect(
      page.getByTestId(`org-listing-row-${fixture.orgListingId}`),
    ).not.toBeVisible({ timeout: 10_000 });
  });
});
