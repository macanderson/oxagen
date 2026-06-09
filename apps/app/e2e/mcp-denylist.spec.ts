/**
 * mcp-denylist.spec.ts
 *
 * E2E flow 7: Denylist — denied server visible in marketplace but not installable.
 *
 * Steps:
 *   1. Seed an org with one catalog server.
 *   2. Open the Plugins settings page, click "Deny a plugin", enter the
 *      server name, submit.
 *   3. Open the marketplace dialog.
 *   4. Assert the server card is still VISIBLE (not removed).
 *   5. Assert the card has `data-denied="true"` (greyed-out treatment).
 *   6. Assert the denied badge renders inside the card.
 *   7. Assert the card button is disabled (cannot navigate to detail).
 *
 * Testids used:
 *   denylist-add-btn                    — "Deny a plugin" button (DenylistSection)
 *   denylist-server-name-input          — server name text input
 *   denylist-submit-btn                 — form submit button
 *   browse-marketplace-btn              — "Browse marketplace" button
 *   marketplace-modal                   — the DialogPopup wrapper
 *   marketplace-tab-mcp_server          — MCP Servers tab
 *   marketplace-server-card-{id}        — server card button (uses catalog DB id)
 *   marketplace-denied-badge-{id}       — "Blocked by your organization's admins" text
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("mcp-denylist", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `denylist-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-deny-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("denied server is visible in marketplace with blocked treatment and install disabled", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // ── Step 1: add the server name to the denylist ───────────────────────────
    await page.getByTestId("denylist-add-btn").click();
    const nameInput = page.getByTestId("denylist-server-name-input");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(fixture.serverName);
    await page.getByTestId("denylist-submit-btn").click();

    // Wait for the denylist entry to appear (server name shows in the table).
    await expect(page.getByText(fixture.serverName)).toBeVisible({ timeout: 10_000 });

    // ── Step 2: open marketplace ──────────────────────────────────────────────
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-modal")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // ── Step 3: verify server card is present but denied ─────────────────────
    const card = page.getByTestId(`marketplace-server-card-${fixture.catalogServerId}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Card must carry data-denied="true" (the greyed-out CSS treatment).
    await expect(card).toHaveAttribute("data-denied", "true");

    // Denied badge / explanatory copy must appear inside the card.
    const deniedBadge = page.getByTestId(`marketplace-denied-badge-${fixture.catalogServerId}`);
    await expect(deniedBadge).toBeVisible();
    await expect(deniedBadge).toContainText(/blocked by your organization/i);

    // The card button must be disabled — cannot navigate to detail / install.
    await expect(card).toBeDisabled();
  });
});
