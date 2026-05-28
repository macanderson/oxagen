import { test, expect } from "@playwright/test";

// E2E layer for the agent.task.background.start capability. Background
// task creation surfaces in the tasks tray; the tray itself is
// workspace-scoped behind auth.
test.describe("agent.task.background.start", () => {
  test("background tasks tray requires auth", async ({ page }) => {
    await page.goto("/agent/tasks");
    await expect(page).toHaveURL(/\/login$/);
  });
});
