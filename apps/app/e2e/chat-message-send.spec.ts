import { test, expect } from "@playwright/test";

test.describe("chat.message.send", () => {
  test("chat page guards unauthenticated access", async ({ page }) => {
    await page.goto("/acme/default/chat");
    await expect(page).toHaveURL(/\/login$/);
  });
});
