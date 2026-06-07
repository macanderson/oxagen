/**
 * organization.slug-change — e2e spec.
 *
 * A fresh user opens /{orgSlug}/settings/general, renames the org slug, and
 * submits. Asserts the app redirects to the new slug's settings URL (the slug
 * is the first path segment, so a change must move the user to the new URL).
 *
 * Also covers the auth guard on the settings route.
 *
 * Gap covered: no existing spec exercised changing an organization slug.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("organization.slug-change — auth guard", () => {
  test("settings route requires auth", async ({ page }) => {
    await page.goto("/some-org/settings/general");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("organization.slug-change — happy path", () => {
  test("renaming the slug redirects to the new slug URL", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "org-slug" });

    await page.goto(`/${orgSlug}/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    const slugInput = page.locator('input[name="slug"]');
    await expect(slugInput).toBeVisible({ timeout: 10_000 });

    // Native HTML5 pattern validation can block submit under Chrome's Unicode
    // "v" flag (see signup helper). Drop the attribute; the server action
    // validates the slug independently.
    await slugInput.evaluate((el) => el.removeAttribute("pattern"));

    const newSlug = `org-renamed-${uid()}`;
    await slugInput.clear();
    await slugInput.fill(newSlug);

    await page.getByRole("button", { name: /save changes/i }).click();

    // The client redirects to the new slug's settings URL after a successful
    // slug change. Assert we land there (and not back on /login).
    await page.waitForURL(new RegExp(`/${newSlug}/settings/general`), {
      timeout: 15_000,
    });
    await expect(page).not.toHaveURL(/\/login/);
    expect(new URL(page.url()).pathname).toContain(newSlug);
  });
});
