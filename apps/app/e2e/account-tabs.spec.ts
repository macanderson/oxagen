/**
 * account-tabs.spec.ts
 *
 * web-app-2.0 Phase 1: proves the consolidated /account/* tab strip chrome
 * (apps/app/src/app/account/account-tabs.tsx, rendered from layout.tsx) is
 * present on every account page and that clicking each tab navigates to the
 * right sub-page with that page's own content intact — against the real UI,
 * no mocks. The four pages themselves (Profile, Preferences, Security,
 * Privacy) are pre-existing and unchanged; this only proves the shared
 * chrome added on top of them.
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
  "account-tabs",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("Account settings — consolidated tab strip", () => {
  test("tab strip is visible on every /account/* page and navigates correctly", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // ── 1. Fresh user, then land on Profile ──────────────────────────────
    await signUpFreshUser(page, { orgPrefix: "acct-tabs" });
    await gotoStable(page, "/account/profile");
    await expect(page).not.toHaveURL(/\/login/);

    // ── 2. Tab strip visible with all four tabs, Profile active ─────────
    const tabStrip = page.getByTestId("account-tab-strip");
    await expect(tabStrip).toBeVisible({ timeout: 15_000 });
    await expect(tabStrip.getByRole("tab", { name: "Profile" })).toBeVisible();
    await expect(
      tabStrip.getByRole("tab", { name: "Preferences" }),
    ).toBeVisible();
    await expect(tabStrip.getByRole("tab", { name: "Security" })).toBeVisible();
    await expect(tabStrip.getByRole("tab", { name: "Privacy" })).toBeVisible();
    await expect(tabStrip.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-profile-tab-strip.png"),
      fullPage: true,
    });

    // ── 3. Preferences tab → URL + form ──────────────────────────────────
    await tabStrip.getByRole("tab", { name: "Preferences" }).click();
    await page.waitForURL((url) => url.pathname === "/account/preferences", {
      timeout: 15_000,
    });
    await expect(
      page.getByRole("form", { name: /preferences settings/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      tabStrip.getByRole("tab", { name: "Preferences" }),
    ).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-preferences.png"),
      fullPage: true,
    });

    // ── 4. Security tab → MFA "not enrolled" state ──────────────────────
    await tabStrip.getByRole("tab", { name: "Security" }).click();
    await page.waitForURL((url) => url.pathname === "/account/security", {
      timeout: 15_000,
    });
    await expect(page.getByText(/multi-factor authentication/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/not enrolled/i)).toBeVisible();
    await expect(tabStrip.getByRole("tab", { name: "Security" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-security.png"),
      fullPage: true,
    });

    // ── 5. Privacy tab → export/erase controls ───────────────────────────
    await tabStrip.getByRole("tab", { name: "Privacy" }).click();
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
    await expect(tabStrip.getByRole("tab", { name: "Privacy" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-privacy.png"),
      fullPage: true,
    });
  });
});
