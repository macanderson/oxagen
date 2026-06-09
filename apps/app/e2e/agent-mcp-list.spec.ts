/**
 * agent.mcp.list — e2e spec.
 *
 * Asserts the MCP servers panel requires auth AND that it renders for an
 * authenticated user with a fresh org (no seeded MCP servers).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.mcp.list — auth guard", () => {
  test("MCP servers panel requires auth", async ({ page }) => {
    await page.goto("/agent/mcp-servers");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.mcp.list — authenticated", () => {
  test("MCP servers panel is reachable and renders for a fresh org", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mcp-list" });

    // Navigate to the MCP developer page (correct route: /developer/mcp).
    await page.goto(`/${orgSlug}/developer/mcp`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/developer/mcp`));
    // MCP server heading confirms the page rendered.
    await expect(page.getByText("MCP server")).toBeVisible();
  });
});
