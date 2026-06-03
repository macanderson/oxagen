/**
 * agent.tool.list — e2e spec.
 *
 * Asserts the tools panel requires auth AND that a fresh-signup user can
 * reach the workspace tools page (even if no tools are seeded yet).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.tool.list — auth guard", () => {
  test("agent tools panel requires auth", async ({ page }) => {
    await page.goto("/agent/tools");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.tool.list — authenticated", () => {
  test("tools page is reachable for a fresh org's workspace", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "tool-list" });

    await page.goto(`/${orgSlug}/default/tools`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/default`));
  });
});
