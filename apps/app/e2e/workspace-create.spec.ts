/**
 * workspace.create — e2e spec.
 *
 * The default workspace is created automatically during org onboarding.
 * This spec verifies that after signup + org creation the workspace is
 * reachable and the workspace shell renders, exercising the
 * workspace.create capability end-to-end.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("workspace.create — auth guard", () => {
  test("workspace route requires tenant context (redirects to /login without auth)", async ({
    page,
  }) => {
    await page.goto("/acme");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("workspace.create — happy path", () => {
  test("signup + org onboarding creates a default workspace and lands in it", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "ws-create" });

    // After org creation, the form redirects to /<orgSlug>/default (default ws).
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/`));

    // The workspace shell renders — navigate to the chat page explicitly and
    // verify the workspace URL segment is present.
    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(new RegExp(`${orgSlug}/default`));

    // The chat composer (textarea) must be present in the workspace shell.
    await expect(page.getByPlaceholder(/send a message/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
