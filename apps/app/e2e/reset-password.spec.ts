/**
 * reset-password.spec.ts — E2E tests for the forgot-password / reset-password flow.
 *
 * Strategy for token delivery in E2E:
 *   Real reset tokens arrive via email, which is unavailable in the test
 *   environment (no live SMTP inbox). We therefore test:
 *
 *   1. The REQUEST side: /forgot-password form submission → neutral
 *      confirmation screen (does not confirm/deny account existence).
 *
 *   2. The RESET side — unauthenticated access:
 *      a. /reset-password with NO token → shows the "invalid/expired" error UI.
 *      b. /reset-password with a deliberately wrong token → the server action
 *         returns an error; the form shows the friendly expired-link UI.
 *
 *   3. Navigation: "Forgot password?" link is visible on the login page.
 *
 * We deliberately do NOT drive a happy-path token redemption in e2e because
 * it would require either SMTP interception (not provisioned) or calling the
 * internal DB to extract the token (fragile, couples the test to internals).
 * The full happy path is covered by unit tests (resetPasswordAction) and the
 * auth.config.test.ts / email-template tests.
 *
 * These tests are stable, deterministic, and require no external services.
 */

import { test, expect } from "@playwright/test";

// ─── 1. Login page has "Forgot password?" link ───────────────────────────────

test.describe("forgot-password link on login page", () => {
  test("login page renders a Forgot password link pointing to /forgot-password", async ({
    page,
  }) => {
    await page.goto("/login");
    const link = page.getByRole("link", { name: /forgot password/i });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });
});

// ─── 2. /forgot-password page ────────────────────────────────────────────────

test.describe("forgot-password page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/forgot-password");
  });

  test("renders heading and email input", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /forgot your password/i })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: /send reset link/i })).toBeVisible();
  });

  test("shows neutral confirmation message after submitting a valid email", async ({ page }) => {
    await page.fill('input[name="email"]', "test@example.com");
    await page.getByRole("button", { name: /send reset link/i }).click();

    // The server action always returns ok:true regardless of account existence.
    // We expect the neutral confirmation copy to appear.
    await expect(
      page.getByText(/if an account with that email exists/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("stays on form and shows validation error for a malformed email", async ({ page }) => {
    await page.fill('input[name="email"]', "not-an-email");
    await page.getByRole("button", { name: /send reset link/i }).click();

    // The Zod validation returns ok:false; the form renders the error message.
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 5_000 });
  });

  test("has a link back to the login page", async ({ page }) => {
    const link = page.getByRole("link", { name: /sign in/i });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("Send another link button re-shows the form after confirmation", async ({ page }) => {
    await page.fill('input[name="email"]', "test@example.com");
    await page.getByRole("button", { name: /send reset link/i }).click();

    await expect(page.getByText(/if an account with that email exists/i)).toBeVisible({
      timeout: 10_000,
    });

    // Click "Send another link" to go back to the form.
    await page.getByRole("button", { name: /send another link/i }).click();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: /send reset link/i })).toBeVisible();
  });
});

// ─── 3. /reset-password page ─────────────────────────────────────────────────

test.describe("reset-password page", () => {
  test("with no token shows invalid/expired error UI immediately", async ({ page }) => {
    // No ?token= param → page server component passes empty string → form
    // initialises in "invalid-token" state.
    await page.goto("/reset-password");

    await expect(
      page.getByText(/invalid or has expired|invalid.*link/i),
    ).toBeVisible({ timeout: 5_000 });

    // The "Request a new link" button should be visible.
    await expect(
      page.getByRole("link", { name: /request a new link/i }),
    ).toBeVisible();
  });

  test("with an invalid token shows error after form submission", async ({ page }) => {
    await page.goto("/reset-password?token=definitely-invalid-token");

    // The form should render with two password fields.
    await expect(page.getByLabel("New password")).toBeVisible();
    await expect(page.getByLabel("Confirm password")).toBeVisible();

    await page.fill('input[name="newPassword"]', "newpassword123");
    await page.fill('input[name="confirmPassword"]', "newpassword123");
    await page.getByRole("button", { name: /set new password/i }).click();

    // The server action returns invalid token error → form shows friendly msg.
    await expect(
      page.getByText(/invalid or has expired/i),
    ).toBeVisible({ timeout: 10_000 });

    // The "Request a new link" button should appear.
    await expect(
      page.getByRole("link", { name: /request a new link/i }),
    ).toBeVisible();
  });

  test("with mismatched passwords shows a validation error without calling the API", async ({
    page,
  }) => {
    await page.goto("/reset-password?token=some-token-value");

    await page.fill('input[name="newPassword"]', "password123");
    await page.fill('input[name="confirmPassword"]', "different456");
    await page.getByRole("button", { name: /set new password/i }).click();

    await expect(page.getByRole("alert")).toContainText(/do not match/i, {
      timeout: 5_000,
    });
  });

  test("has a back-to-sign-in link", async ({ page }) => {
    await page.goto("/reset-password?token=irrelevant");
    const link = page.getByRole("link", { name: /back to sign in/i });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/login/);
  });
});
