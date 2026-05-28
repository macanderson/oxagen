import { test, expect } from "@playwright/test";

// E2E layer for the agent.plan.approve capability. The plan approval
// surface lives inside the chat; an unauthenticated visit redirects.
test.describe("agent.plan.approve", () => {
  test("plan approval surface requires auth", async ({ page }) => {
    await page.goto("/agent/plans/pending");
    await expect(page).toHaveURL(/\/login$/);
  });
});
