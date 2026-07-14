/**
 * account-nav.spec.ts
 *
 * web-app-2.0: proves the /account/* section navigates SOLELY via the
 * mode-aware application-shell sidebar (account mode: Profile / Preferences /
 * Security / Privacy) — the in-page secondary tab strip that used to duplicate
 * the sidebar has been removed. Clicking each sidebar item navigates to the
 * right sub-page, marks it active (aria-current="page"), and the page's own
 * content is intact — against the real UI, no mocks.
 *
 * Also asserts the removed chrome is truly gone: the old `account-tab-strip`
 * test id must not be present on any account page.
 *
 * This spec is the UI-parity proof for `update_user_preferences` (it exercises
 * the /account/preferences form), so it keeps that page's coverage.
 *
 * Screenshots of the key success states go to a dedicated, gitignored
 * sub-directory recreated on each run (CLAUDE.md convention).
 */

import { test, expect } from "@playwright/test";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "account-nav",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("Account settings — sidebar is the single navigation", () => {
  test("account sub-pages are reachable via the shell sidebar, no tab strip", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // ── 1. Fresh user, then land on Profile ──────────────────────────────
    await signUpFreshUser(page, { orgPrefix: "acct-nav" });
    await gotoStable(page, "/account/profile");
    await expect(page).not.toHaveURL(/\/login/);

    // The account nav lives in the mode-aware shell sidebar (desktop).
    const sidebar = page.locator('aside[aria-label="Primary navigation"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // ── 2. Sidebar lists all four account destinations, Profile active ───
    const profileLink = sidebar.getByRole("link", {
      name: "Profile",
      exact: true,
    });
    const preferencesLink = sidebar.getByRole("link", {
      name: "Preferences",
      exact: true,
    });
    const securityLink = sidebar.getByRole("link", {
      name: "Security",
      exact: true,
    });
    const privacyLink = sidebar.getByRole("link", {
      name: "Privacy",
      exact: true,
    });

    await expect(profileLink).toBeVisible();
    await expect(preferencesLink).toBeVisible();
    await expect(securityLink).toBeVisible();
    await expect(privacyLink).toBeVisible();
    await expect(profileLink).toHaveAttribute("aria-current", "page");

    // The removed secondary tab strip must not exist on any account page.
    await expect(page.getByTestId("account-tab-strip")).toHaveCount(0);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-profile-sidebar.png"),
      fullPage: true,
    });

    // ── 3. Preferences via sidebar → URL + form (parity proof) ───────────
    await preferencesLink.click();
    await page.waitForURL((url) => url.pathname === "/account/preferences", {
      timeout: 15_000,
    });
    await expect(
      page.getByRole("form", { name: /preferences settings/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(preferencesLink).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("account-tab-strip")).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-preferences.png"),
      fullPage: true,
    });

    // ── 4. Security via sidebar → MFA "not enrolled" state ───────────────
    await securityLink.click();
    await page.waitForURL((url) => url.pathname === "/account/security", {
      timeout: 15_000,
    });
    await expect(page.getByText(/multi-factor authentication/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/not enrolled/i)).toBeVisible();
    await expect(securityLink).toHaveAttribute("aria-current", "page");
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-security.png"),
      fullPage: true,
    });

    // ── 5. Privacy via sidebar → export/erase controls ───────────────────
    await privacyLink.click();
    await page.waitForURL((url) => url.pathname === "/account/privacy", {
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: /export your data/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /request data export/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /delete your account/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /delete my account/i }),
    ).toBeVisible();
    await expect(privacyLink).toHaveAttribute("aria-current", "page");
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-privacy.png"),
      fullPage: true,
    });
  });
});
