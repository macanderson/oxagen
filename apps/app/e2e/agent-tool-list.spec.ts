import { test, expect } from "@playwright/test";

// E2E layer for the agent.tool.list capability. The runner-tools panel
// renders the materialized tool list for the active workspace; full
// happy-path requires a seeded workspace, so we assert the route guard.
test.describe("agent.tool.list", () => {
  test("agent tools panel requires auth", async ({ page }) => {
    await page.goto("/agent/tools");
    await expect(page).toHaveURL(/\/login$/);
  });
});
