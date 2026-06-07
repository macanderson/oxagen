/**
 * workspace.slug-change — e2e spec.
 *
 * A fresh user opens the default workspace's general settings
 * (/{orgSlug}/default/settings/general), renames the workspace slug, and
 * submits. Asserts the app redirects to the new workspace-slug URL (the
 * workspace slug is the second path segment).
 *
 * Also covers the auth guard on the workspace settings route.
 *
 * Gap covered: no existing spec exercised changing a workspace slug.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("workspace.slug-change — auth guard", () => {
  test("workspace settings route requires auth", async ({ page }) => {
    await page.goto("/some-org/default/settings/general");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("workspace.slug-change — happy path", () => {
  test("renaming the workspace slug redirects to the new workspace URL", async ({
    page,
  }) => {
    // signUpFreshUser lands on the org's "default" workspace.
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "ws-slug" });

    await page.goto(`/${orgSlug}/default/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    const slugInput = page.locator('input[name="slug"]');
    await expect(slugInput).toBeVisible({ timeout: 10_000 });

    // Drop native pattern validation (Chrome Unicode "v" flag); the server
    // action validates the slug independently.
    await slugInput.evaluate((el) => el.removeAttribute("pattern"));

    const newSlug = `ws-renamed-${uid()}`;
    await slugInput.clear();
    await slugInput.fill(newSlug);

    await page.getByRole("button", { name: /save changes/i }).click();

    // The client replaces the URL with the new workspace-slug settings path
    // after a successful change.
    await page.waitForURL(
      new RegExp(`/${orgSlug}/${newSlug}/settings/general`),
      { timeout: 15_000 },
    );
    await expect(page).not.toHaveURL(/\/login/);
    expect(new URL(page.url()).pathname).toContain(`/${newSlug}/`);
  });
});
