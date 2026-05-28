import { test, expect } from "@playwright/test";

test.describe("billing.subscription.read", () => {
  test("billing page guards unauthenticated access", async ({ page }) => {
    await page.goto("/acme/settings/billing");
    await expect(page).toHaveURL(/\/login$/);
  });
});
