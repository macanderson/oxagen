import { test, expect } from "@playwright/test";

// E2E layer for the agent.task.background.read capability. Task detail
// pages are workspace-scoped; the auth gate is the deterministic check.
test.describe("agent.task.background.read", () => {
  test("background task detail requires auth", async ({ page }) => {
    await page.goto("/agent/tasks/task_placeholder");
    await expect(page).toHaveURL(/\/login$/);
  });
});
