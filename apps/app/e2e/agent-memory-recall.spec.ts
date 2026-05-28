import { test, expect } from "@playwright/test";

// E2E layer for the agent.memory.recall capability. The memory explorer
// is workspace-scoped; assert the auth gate without seeded data.
test.describe("agent.memory.recall", () => {
  test("memory explorer requires auth", async ({ page }) => {
    await page.goto("/agent/memory");
    await expect(page).toHaveURL(/\/login$/);
  });
});
