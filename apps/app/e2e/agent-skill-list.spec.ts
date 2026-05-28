import { test, expect } from "@playwright/test";

// E2E layer for the agent.skill.list capability. The skills drawer
// lists built-in plus tenant skills; route is workspace-scoped.
test.describe("agent.skill.list", () => {
  test("skills drawer requires auth", async ({ page }) => {
    await page.goto("/agent/skills");
    await expect(page).toHaveURL(/\/login$/);
  });
});
