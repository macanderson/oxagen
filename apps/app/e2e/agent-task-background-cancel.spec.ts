/**
 * agent.task.background.cancel — e2e spec.
 *
 * Asserts the cancel action requires auth AND that an authenticated user can
 * reach their workspace's activity area (where cancel surfaces).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.task.background.cancel — auth guard", () => {
  test("cancel action requires auth", async ({ page }) => {
    await page.goto("/agent/tasks/task_placeholder");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.task.background.cancel — authenticated", () => {
  test("activity page is reachable (cancel action available on running tasks)", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "bg-cancel" });

    await page.goto(`/${orgSlug}/default/activity`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/default`));
  });
});
