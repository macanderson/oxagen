import { test, expect } from "@playwright/test";

// E2E layer for the organization.create capability. Full happy path requires a
// seeded user; we assert the UI contract and route guard here.
test.describe("organization.create", () => {
  test("new-tenant form requires auth", async ({ page }) => {
    await page.goto("/new-organization");
    await expect(page).toHaveURL(/\/login$/);
  });
});
