/**
 * agent.task.background.read — e2e spec.
 *
 * Asserts the background task detail requires auth AND that an authenticated
 * user can reach their workspace's activity page.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.task.background.read — auth guard", () => {
  test("background task detail requires auth", async ({ page }) => {
    await page.goto("/agent/tasks/task_placeholder");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.task.background.read — authenticated", () => {
  test("activity page is reachable for reading background task status", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "bg-read" });

    await page.goto(`/${orgSlug}/default/activity`);
    await expect(page).not.toHaveURL(/\/login/);
    // Activity root redirects to /activity/runs.
    await expect(page).toHaveURL(/activity\/runs/);
    // Mock runs table heading is visible — confirms the page rendered.
    await expect(page.getByText("Recent runs")).toBeVisible();
  });
});
