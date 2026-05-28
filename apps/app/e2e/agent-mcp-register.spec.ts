import { test, expect } from "@playwright/test";

// E2E layer for the agent.mcp.register capability. The "add MCP server"
// dialog is workspace-scoped; we assert the auth boundary here and defer
// the full registration flow to the integration suite.
test.describe("agent.mcp.register", () => {
  test("add-MCP-server form requires auth", async ({ page }) => {
    await page.goto("/agent/mcp-servers/new");
    await expect(page).toHaveURL(/\/login$/);
  });
});
