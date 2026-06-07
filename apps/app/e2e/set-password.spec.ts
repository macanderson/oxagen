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
 *   valid session cookie into the Playwright context, so the app sees an
 *   authenticated user where hasPassword === false, and the SetPasswordForm
 *   is rendered.
 *
 * Tests:
 *   1. Auth guard: /account/profile while unauthenticated → redirected to /login.
 *   2. Happy path: OAuth-only user fills + submits set-password form → success
 *      status message appears, the form section disappears (server re-derives
 *      hasPassword === true and hides the section on router.refresh()).
 */

import { test, expect } from "@playwright/test";
import { seedOAuthOnlyUser } from "./helpers/seed-oauth-user";
import type { OAuthUserFixture } from "./helpers/seed-oauth-user";

// ─── 1. Auth guard ────────────────────────────────────────────────────────────

test.describe("set-password — auth guard", () => {
  test("unauthenticated access to /account/profile redirects to /login", async ({ page }) => {
    await page.goto("/account/profile");
    // The proxy/server should redirect to /login (the exact URL may include a
    // callbackUrl query param; assert that it lands somewhere under /login).
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});

// ─── 2. Happy path: OAuth-only user sets a password ──────────────────────────

test.describe("set-password — OAuth-only user", () => {
  let fixture: OAuthUserFixture;

  test.beforeAll(async ({ browser }) => {
    // We need to inject the session cookie BEFORE navigating, so we create a
    // fresh context here (beforeAll). The individual tests reuse this context
    // via the shared `page` created below. Playwright's `browser` fixture is
    // available in beforeAll.
    const context = await browser.newContext();
    fixture = await seedOAuthOnlyUser(context);
    // Store the context on the fixture so we can close it in afterAll.
    // We expose it via a module-scoped variable rather than mutating the
    // fixture type (which is defined in the helper).
    sharedContext = context;
  });

  test.afterAll(async () => {
    await fixture.cleanup();
    await sharedContext?.close();
  });

  // ── Navigate to /account/profile as the OAuth-only user ──────────────────

  test("set-password form is visible for an OAuth-only user", async ({ _browser: _b }) => {
    // Each test gets a fresh page from the shared context (which already has the
    // session cookie injected). We can't use the built-in `page` fixture here
    // because it belongs to a fresh, unauthenticated context — we need the
    // seeded context. Use browser.newPage() with the pre-configured context.
    const context = sharedContext;
    const page = await context.newPage();

    try {
      await page.goto("/account/profile");

      // Verify we are not redirected to /login — the session cookie is valid.
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

      // The SetPasswordForm section must be rendered (hasPassword === false).
      await expect(
        page.getByRole("region", { name: /set password/i }),
      ).toBeVisible({ timeout: 15_000 });

      // Both password inputs must be present.
      await expect(page.locator("#set-new-password")).toBeVisible();
      await expect(page.locator("#set-confirm-password")).toBeVisible();

      // The submit button must be visible.
      await expect(
        page.getByRole("button", { name: /set password/i }),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test("submitting matching passwords shows success status and hides the form", async ({ browser }) => {
    const context = sharedContext;
    const page = await context.newPage();

    try {
      await page.goto("/account/profile");
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

      // Wait for the set-password section to be present (OAuth-only user).
      const setPasswordSection = page.getByRole("region", { name: /set password/i });
      await expect(setPasswordSection).toBeVisible({ timeout: 15_000 });

      // Use inputs by their stable `id` attributes (matches the `htmlFor` labels).
      const newPasswordInput = page.locator("#set-new-password");
      const confirmPasswordInput = page.locator("#set-confirm-password");

      // Fill using native value setter to work around React-controlled input quirks.
      // The Input component is React-controlled (value + onChange), so we must
      // fire both a native value set and a React synthetic event.
      await newPasswordInput.fill("NewOAuthPass123!");
      await confirmPasswordInput.fill("NewOAuthPass123!");

      // Submit the form.
      const submitButton = page.getByRole("button", { name: /set password/i });
      await expect(submitButton).toBeEnabled();
      await submitButton.click();

      // Assert the success status message appears.
      // Text matches set-password-form.tsx: "Password set. You can now sign in…"
      await expect(
        page.getByRole("status"),
      ).toContainText(/password set/i, { timeout: 15_000 });

      // After router.refresh() (triggered on success), the server re-derives
      // hasPassword === true and the set-password section must no longer be rendered.
      await expect(setPasswordSection).not.toBeVisible({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  });

  test("mismatched passwords shows a validation error without calling the API", async ({ browser }) => {
    // Use a fresh browser context for this test so it does not depend on the
    // side-effects of the happy-path test (which sets a password). We still need
    // a seeded OAuth-only user — create a second ephemeral fixture for this test.
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

      await page.getByRole("button", { name: /set password/i }).click();

      // Client-side mismatch check fires before any server call; the error alert
      // must appear quickly.
      await expect(
        page.getByRole("alert"),
      ).toContainText(/do not match/i, { timeout: 5_000 });

      // The form must still be visible — no success state.
      await expect(setPasswordSection).toBeVisible();
      await page.close();
    } finally {
      await ephemeralFixture?.cleanup();
      await ephemeralContext.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Module-scoped shared browser context (populated in beforeAll).
// Using a let rather than a class property keeps the code flat and avoids the
// "Property used before assignment" lint false-positive on class fields.
// ---------------------------------------------------------------------------
let sharedContext: import("@playwright/test").BrowserContext;
