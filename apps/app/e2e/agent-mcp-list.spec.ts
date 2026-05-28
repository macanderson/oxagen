import { test, expect } from "@playwright/test";

// E2E layer for the agent.mcp.list capability. The MCP servers panel
// shows registered external servers with their health; the auth gate
// is the only deterministic assertion without seeded data.
test.describe("agent.mcp.list", () => {
  test("MCP servers panel requires auth", async ({ page }) => {
    await page.goto("/agent/mcp-servers");
    await expect(page).toHaveURL(/\/login$/);
  });
});
