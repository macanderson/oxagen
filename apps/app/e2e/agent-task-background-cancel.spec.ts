import { test, expect } from "@playwright/test";

// E2E layer for the agent.task.background.cancel capability. The cancel
// action lives on the task detail page; we assert the auth boundary.
test.describe("agent.task.background.cancel", () => {
  test("cancel action requires auth", async ({ page }) => {
    await page.goto("/agent/tasks/task_placeholder");
    await expect(page).toHaveURL(/\/login$/);
  });
});
