/**
 * set-password.spec.ts — E2E tests for the "set password" flow.
 *
 * Target: /account/profile — the SetPasswordForm section shown to OAuth-only
 * users (users with no credential account, i.e. hasPassword === false).
 *
 * Strategy:
 *   The existing e2e harness only signs users up with email+password, meaning
 *   those users already have a "credential" account and setPassword would return
 *   PASSWORD_ALREADY_SET. To test the happy path we need a user with a social
 *   account (github) and NO password credential.
 *
 *   seedOAuthOnlyUser() inserts exactly that state into the DB and injects a
 *   valid session cookie into the Playwright BrowserContext, so the app sees an
 *   authenticated user where hasPassword === false and the SetPasswordForm is
 *   rendered on /account/profile.
 *
 * Tests:
 *   1. Auth guard: /account/profile while unauthenticated → redirected to /login.
 *   2. Form visibility: OAuth-only user lands on /account/profile and sees the
 *      set-password section (both inputs + submit button visible).
 *   3. Happy path: submitting matching passwords shows success status message
 *      and the set-password section disappears (router.refresh() causes the
 *      server to re-derive hasPassword === true and hide the section).
 *   4. Mismatch guard: mismatched passwords show a client-side error without
 *      calling the server action.
 */

import { test, expect, type BrowserContext } from "@playwright/test";
import { seedOAuthOnlyUser } from "./helpers/seed-oauth-user";
import type { OAuthUserFixture } from "./helpers/seed-oauth-user";

// ─── 1. Auth guard ────────────────────────────────────────────────────────────

test.describe("set-password — auth guard", () => {
  test("unauthenticated access to /account/profile redirects to /login", async ({
    page,
  }) => {
    await page.goto("/account/profile");
    // The proxy/server redirects unauthenticated requests to /login.
    // The exact URL may include a callbackUrl query param.
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});

// ─── 2–4. OAuth-only user — shared seeded context ────────────────────────────
//
// We share one BrowserContext (with the session cookie already injected) across
// all three authenticated tests. The context is created in beforeAll and closed
// in afterAll. Each test opens its own page so they can run independently.

test.describe("set-password — OAuth-only user", () => {
  // Populated in beforeAll; used across tests.
  let fixture: OAuthUserFixture;
  let authedContext: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    authedContext = await browser.newContext();
    fixture = await seedOAuthOnlyUser(authedContext);
  });

  test.afterAll(async () => {
    await fixture.cleanup();
    await authedContext.close();
  });

  test("set-password form is visible for an OAuth-only user", async () => {
    const page = await authedContext.newPage();

    try {
      await page.goto("/account/profile");

      // Session cookie is valid — must NOT redirect to /login.
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

      // The SetPasswordForm section must be rendered (hasPassword === false).
      // The <section> has aria-label="Set password" → role="region".
      await expect(
        page.getByRole("region", { name: /set password/i }),
      ).toBeVisible({ timeout: 15_000 });

      // Both password inputs must be present (identified by their stable `id`s).
      await expect(page.locator("#set-new-password")).toBeVisible();
      await expect(page.locator("#set-confirm-password")).toBeVisible();

      // The submit button must be present.
      await expect(
        page.getByRole("button", { name: /^set password$/i }),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test("submitting matching passwords shows success status and hides the section", async () => {
    const page = await authedContext.newPage();

    try {
      await page.goto("/account/profile");
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

      const setPasswordSection = page.getByRole("region", { name: /set password/i });
      await expect(setPasswordSection).toBeVisible({ timeout: 15_000 });

      // Fill both inputs. Playwright's .fill() fires real input events which
      // update the React-controlled state (value + onChange).
      await page.locator("#set-new-password").fill("NewOAuthPass123!");
      await page.locator("#set-confirm-password").fill("NewOAuthPass123!");

      const submitButton = page.getByRole("button", { name: /^set password$/i });
      await expect(submitButton).toBeEnabled();
      await submitButton.click();

      // On success, SetPasswordForm renders a <p role="status"> with:
      // "Password set. You can now sign in with your email and password."
      await expect(
        page.getByRole("status"),
      ).toContainText(/password set/i, { timeout: 20_000 });

      // After router.refresh() (triggered inside the success handler), the server
      // re-derives hasPassword === true and stops rendering SetPasswordForm.
      await expect(setPasswordSection).not.toBeVisible({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  });

  test("mismatched passwords show a client-side error without submitting to the server", async ({
    browser,
  }) => {
    // This test must NOT reuse the shared authedContext — the happy-path test
    // above already set a password for that user, so hasPassword would now be
    // true and the form would not be visible. Use a fresh ephemeral OAuth-only
    // user instead.
    const ephemeralContext = await browser.newContext();
    let ephemeralFixture: OAuthUserFixture | undefined;

    try {
      ephemeralFixture = await seedOAuthOnlyUser(ephemeralContext);
      const page = await ephemeralContext.newPage();

      await page.goto("/account/profile");
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

      const setPasswordSection = page.getByRole("region", { name: /set password/i });
      await expect(setPasswordSection).toBeVisible({ timeout: 15_000 });

      await page.locator("#set-new-password").fill("password123!");
      await page.locator("#set-confirm-password").fill("differentpass!");
      await page.getByRole("button", { name: /^set password$/i }).click();

      // Client-side mismatch check fires synchronously before any server call.
      // SetPasswordForm renders <p role="alert"> with "Passwords do not match".
      await expect(
        page.getByRole("alert"),
      ).toContainText(/do not match/i, { timeout: 5_000 });

      // The form remains visible — no success state.
      await expect(setPasswordSection).toBeVisible();

      await page.close();
    } finally {
      await ephemeralFixture?.cleanup();
      await ephemeralContext.close();
    }
  });
});
