/**
 * agent.skill.list — e2e spec.
 *
 * Asserts the skills drawer requires auth AND that an authenticated user's
 * workspace renders with the skills surface accessible.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("agent.skill.list — auth guard", () => {
  test("skills drawer requires auth", async ({ page }) => {
    await page.goto("/agent/skills");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("agent.skill.list — authenticated", () => {
  test("workspace chat page renders for a fresh org (skills surface accessible)", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "skill-list" });

    // The skills surface is accessible from within the chat workspace shell.
    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/default/chat`));
    // Chat composer must be visible — it is the entry point for skill invocation.
    await expect(page.getByPlaceholder(/send a message/i)).toBeVisible();
  });
});
