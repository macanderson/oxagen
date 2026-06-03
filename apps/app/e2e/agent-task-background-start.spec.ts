/**
 * agent.task.background.start — e2e spec.
 *
 * Asserts the background tasks tray requires auth AND that a fresh user can
 * reach their workspace's activity area (where background tasks surface).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.task.background.start — auth guard", () => {
  test("background tasks tray requires auth", async ({ page }) => {
    await page.goto("/agent/tasks");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.task.background.start — authenticated", () => {
  test("activity page is reachable for a fresh org's workspace", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "bg-start" });

    // Background tasks surface in the workspace activity area.
    await page.goto(`/${orgSlug}/default/activity`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/default`));
  });
});
