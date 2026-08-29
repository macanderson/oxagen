/**
 * two-factor-enrollment.spec.ts
 *
 * Security-critical money-path E2E for TOTP 2FA. Proves the full
 * enroll → sign-out → re-sign-in-with-second-factor loop against the real UI
 * and the real Better Auth twoFactor endpoints — no mocks.
 *
 * We don't need a phone: the enrollment endpoint returns the otpauth:// URI
 * containing the shared secret. We intercept that response, extract the secret,
 * and compute valid TOTP codes with otplib (Better Auth uses the TOTP defaults
 * — SHA1, 6 digits, 30s — which are also otplib's defaults).
 *
 * Flow:
 *   1. Sign up a fresh user (real /signup form → real credential account, the
 *      owner of its org — the role the enforcement gate targets).
 *   2. /account/security → confirm password → start enrollment.
 *   3. Capture the /two-factor/enable response → parse the TOTP secret.
 *   4. Submit a valid TOTP code → assert "Enrolled" state + backup codes shown.
 *   5. Clear the session (sign out) → sign in again with email + password.
 *   6. Sign-in withholds the session and routes to /two-factor → complete the
 *      challenge with a fresh code → land back in the app (session minted).
 *
 * Screenshots of the key success states go to a dedicated, gitignored
 * sub-directory recreated on each run (CLAUDE.md convention).
 *
 * NOTE: needs the full local stack (Postgres :5433 via `pnpm dev`) and the app
 * dev server on :3000. It runs in CI's e2e shards; a bare agent shell without
 * the stack cannot execute it.
 */

import { test, expect } from "@playwright/test";
import { authenticator } from "otplib";
import { signUpFreshUser } from "./helpers/signup";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "two-factor-enrollment",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

/** Pull the base32 `secret` out of an otpauth://totp/...?secret=... URI. */
function secretFromTotpUri(totpUri: string): string {
  const match = /[?&]secret=([^&]+)/i.exec(totpUri);
  if (!match?.[1]) {
    throw new Error(`no secret in TOTP URI: ${totpUri}`);
  }
  return decodeURIComponent(match[1]);
}

test.describe("TOTP 2FA — enroll then sign in with the second factor", () => {
  test("enroll via /account/security, then complete the /two-factor challenge on re-login", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ── 1. Fresh, real-password user (org owner) ────────────────────────────
    const { email, password } = await signUpFreshUser(page, {
      orgPrefix: "mfa",
    });

    // ── 2. Open the account security page and start enrollment ──────────────
    await page.goto("/account/security");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(/multi-factor authentication/i)).toBeVisible({
      timeout: 15_000,
    });
    // Starts "Not enrolled".
    await expect(page.getByText(/not enrolled/i)).toBeVisible();

    await page.locator("#mfa-enroll-password").fill(password);

    // Capture the enable response so we can read the TOTP secret.
    const enablePromise = page.waitForResponse(
      (r) =>
        r.url().includes("/two-factor/enable") &&
        r.request().method() === "POST",
      { timeout: 20_000 },
    );
    await page
      .getByRole("button", { name: /set up authenticator app/i })
      .click();
    const enableResp = await enablePromise;
    const body = (await enableResp.json()) as {
      totpURI?: string;
      data?: { totpURI?: string };
    };
    const totpUri = body.totpURI ?? body.data?.totpURI;
    expect(totpUri, "enable response should carry a totpURI").toBeTruthy();
    const secret = secretFromTotpUri(totpUri as string);

    // The QR + backup codes are now on screen.
    await expect(page.getByText(/backup codes/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-enroll-qr-and-backup-codes.png"),
      fullPage: true,
    });

    // ── 3. Submit a valid TOTP code → enrollment confirmed ──────────────────
    await page.locator("#mfa-totp-code").fill(authenticator.generate(secret));
    await page.getByRole("button", { name: /verify & enable/i }).click();

    // router.refresh() re-reads two_factor_enabled → the card flips to Enrolled.
    await expect(page.getByText(/^enrolled$/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/two-factor authentication is/i)).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-enrolled.png"),
      fullPage: true,
    });

    // ── 4. Sign out (drop the session) and sign back in with the password ───
    await page.context().clearCookies();
    await page.goto("/login");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Password alone is not enough now — Better Auth withholds the session and
    // the login form routes to the second-factor page.
    await page.waitForURL((url) => url.pathname === "/two-factor", {
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-two-factor-challenge.png"),
      fullPage: true,
    });

    // ── 5. Complete the challenge with a fresh code → land in the app ───────
    await page.locator("#code").fill(authenticator.generate(secret));
    await page.getByRole("button", { name: /^verify$/i }).click();

    // Session is minted → leave the auth boundary. Not /login, not /two-factor.
    await page.waitForURL(
      (url) =>
        url.pathname !== "/two-factor" && !url.pathname.startsWith("/login"),
      { timeout: 20_000 },
    );
    await expect(page).not.toHaveURL(/\/two-factor/);
    await expect(page).not.toHaveURL(/\/login/);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-signed-in-after-second-factor.png"),
      fullPage: true,
    });
  });
});
