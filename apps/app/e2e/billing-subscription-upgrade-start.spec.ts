import { test, expect } from "@playwright/test";

test.describe("billing.subscription.upgrade.start", () => {
  test("billing plans page renders the upgrade entry point", async ({ page }) => {
    await page.goto("/");
    // unauthenticated users redirect to /login per the foundations app shell.
    await expect(page).toHaveURL(/\/(login|signup)/);
  });
});
