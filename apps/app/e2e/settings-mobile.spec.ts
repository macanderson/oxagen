/**
 * settings-mobile.spec.ts
 *
 * Mobile (390×844) one-thumb UX for the workspace + org settings surfaces
 * (ADR-026 mobile feature parity):
 *   1. The desktop settings sidebar is replaced below `md` by MobileSettingsNav —
 *      a sticky, thumb-reachable (≥44px) section switcher pinned above the app
 *      bottom bar that opens a bottom sheet.
 *   2. The sheet exposes EVERY settings section — identical list to desktop,
 *      nothing dropped on mobile.
 *   3. Selecting a section client-navigates and closes the sheet.
 *   4. Settings pages don't overflow the 390px viewport horizontally.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs.
 */

import { test, expect, type Page } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots", "settings-mobile");

const WORKSPACE_SECTIONS = [
  "General",
  "Members",
  "Models",
  "Budget",
  "GitHub",
  "Prompts",
  "Knowledge",
  "Memory",
  "Environments",
];

const ORG_SECTIONS = ["General", "Privacy"];

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("settings — mobile one-thumb navigation @ 390px", () => {
  test("workspace settings: thumb switcher exposes every section", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mobile-set" });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    // Desktop sidebar is gone; full width belongs to the content.
    const trigger = page.getByTestId("settings-mobile-nav-trigger");
    await expect(trigger).toBeVisible({ timeout: 30_000 });

    // Thumb-sized target (≥44px) per mobile a11y guidance.
    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // Bottom-zone placement: the trigger lives in the lower half of the screen.
    expect(box!.y).toBeGreaterThan(844 / 2);

    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-workspace-settings-general.png"),
      fullPage: false,
    });

    // The sheet exposes the full, desktop-identical section list.
    await trigger.click();
    const sheet = page.getByTestId("settings-mobile-nav-sheet");
    await expect(sheet).toBeVisible();
    for (const label of WORKSPACE_SECTIONS) {
      const link = sheet.getByRole("link", { name: label, exact: true });
      await expect(link).toBeVisible();
      const linkBox = await link.boundingBox();
      expect(linkBox, `section "${label}" bounding box`).not.toBeNull();
      expect(linkBox!.height, `section "${label}" touch target`).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-workspace-settings-sheet.png"),
      fullPage: false,
    });

    // Selecting a section navigates and closes the sheet.
    await sheet.getByRole("link", { name: "Members", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${ws}/settings/members`));
    await expect(sheet).not.toBeVisible();
    await expect(trigger).toContainText("Members");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-workspace-settings-members.png"),
      fullPage: false,
    });
  });

  test("org settings: thumb switcher exposes every section", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "mobile-org" });

    await gotoStable(page, `/${orgSlug}/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    const trigger = page.getByTestId("settings-mobile-nav-trigger");
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-org-settings-general.png"),
      fullPage: false,
    });

    await trigger.click();
    const sheet = page.getByTestId("settings-mobile-nav-sheet");
    await expect(sheet).toBeVisible();
    for (const label of ORG_SECTIONS) {
      await expect(sheet.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-org-settings-sheet.png"),
      fullPage: false,
    });

    await sheet.getByRole("link", { name: "Privacy", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/privacy`));
    await expect(sheet).not.toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "06-org-settings-privacy.png"),
      fullPage: false,
    });
  });
});
