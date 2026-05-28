import { test, expect } from "@playwright/test";

// E2E layer for the tenant.create capability. Full happy path requires a
// seeded user; we assert the UI contract and route guard here.
test.describe("tenant.create", () => {
  test("new-tenant form requires auth", async ({ page }) => {
    await page.goto("/new-tenant");
    await expect(page).toHaveURL(/\/login$/);
  });
});
