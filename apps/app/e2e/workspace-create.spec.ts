import { test, expect } from "@playwright/test";

test.describe("workspace.create", () => {
  test("workspace creation requires tenant context", async ({ page }) => {
    await page.goto("/acme");
    await expect(page).toHaveURL(/\/login$/);
  });
});
