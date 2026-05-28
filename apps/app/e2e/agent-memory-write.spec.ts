import { test, expect } from "@playwright/test";

// E2E layer for the agent.memory.write capability. The "record memory"
// dialog opens off the chat surface; auth gate is the deterministic check.
test.describe("agent.memory.write", () => {
  test("record-memory dialog requires auth", async ({ page }) => {
    await page.goto("/agent/memory/new");
    await expect(page).toHaveURL(/\/login$/);
  });
});
