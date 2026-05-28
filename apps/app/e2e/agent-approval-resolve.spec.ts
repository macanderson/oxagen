import { test, expect } from "@playwright/test";

// E2E layer for the agent.approval.resolve capability. The approval card
// appears inline in the chat stream; the approvals queue is auth-gated.
test.describe("agent.approval.resolve", () => {
  test("pending approvals view requires auth", async ({ page }) => {
    await page.goto("/agent/approvals");
    await expect(page).toHaveURL(/\/login$/);
  });
});
