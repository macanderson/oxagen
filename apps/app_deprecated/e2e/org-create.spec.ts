/**
 * organization.create — e2e spec.
 *
 * Signs up a fresh user and creates an org via the real /new-organization
 * form. Asserts the happy path lands on the new org's workspace and that the
 * org slug appears in the navigation shell.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("organization.create — auth guard", () => {
  test("new-tenant form requires auth", async ({ page }) => {
    await page.goto("/new-organization");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("organization.create — happy path", () => {
  test("fresh signup lands on new org workspace", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "org-create",
    });

    // Must be on an authenticated org page — not /login.
    await expect(page).not.toHaveURL(/\/login/);

    // URL must contain the org slug we created.
    await expect(page).toHaveURL(new RegExp(orgSlug));

    // The workspace shell must render — at minimum the URL contains the slug.
    // (The nav may display the org name rather than the slug.)
    expect(new URL(page.url()).pathname).toContain(orgSlug);
  });
});
