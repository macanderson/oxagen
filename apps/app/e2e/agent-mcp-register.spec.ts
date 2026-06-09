/**
 * agent.mcp.register — e2e spec.
 *
 * Asserts the add-MCP-server form requires auth AND that a fresh-signup
 * user can reach the developer area where MCP server registration lives.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.mcp.register — auth guard", () => {
  test("add-MCP-server form requires auth", async ({ page }) => {
    await page.goto("/agent/mcp-servers/new");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.mcp.register — authenticated", () => {
  test("developer area is reachable for a fresh org", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mcp-reg" });

    // Navigate to the developer MCP page (correct route: /developer/mcp).
    await page.goto(`/${orgSlug}/developer/mcp`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/developer/mcp`));
    // MCP server heading confirms the install page rendered.
    await expect(page.getByText("MCP server")).toBeVisible();
  });
});
