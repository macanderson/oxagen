/**
 * activity-tabs — e2e spec for the Activity → Runs/Fleet/Evals tab strip
 * (web-app-2.0 Phase 1). Signs up a fresh user, lands on the Activity page,
 * asserts the tab strip renders all three tabs, then drives navigation
 * through each tab target:
 *   - Evals  → /evals (own route, kept for URL stability)
 *   - Fleet  → /activity/fleet (Phase 4 shell — asserts no error, not content)
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

test("Activity tab strip navigates Runs / Fleet / Evals", async ({ page }) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-acttabs" });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // ── 1. Land on Activity → tab strip renders all three tabs ──
  await gotoStable(page, `/${user.orgSlug}/default/activity`);
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({
    timeout: 20_000,
  });

  const tabStrip = page.getByTestId("activity-tab-strip");
  await expect(tabStrip).toBeVisible({ timeout: 20_000 });
  const runsTab = tabStrip.getByRole("tab", { name: "Runs" });
  const fleetTab = tabStrip.getByRole("tab", { name: "Fleet" });
  const evalsTab = tabStrip.getByRole("tab", { name: "Evals" });
  await expect(runsTab).toBeVisible();
  await expect(fleetTab).toBeVisible();
  await expect(evalsTab).toBeVisible();
  // Runs is the tab hosting the current route — active by default.
  await expect(runsTab).toHaveAttribute("aria-selected", "true");

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "activity-tab-strip.png"),
    fullPage: true,
  });

  // ── 2. Evals tab → /evals, own page header ──
  await evalsTab.click();
  await page.waitForURL((url) => url.pathname.endsWith("/evals"), {
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "Evals" })).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "activity-tab-evals.png"),
    fullPage: true,
  });

  // ── 3. Back to Activity, then Fleet tab → /activity/fleet, no error ──
  await gotoStable(page, `/${user.orgSlug}/default/activity`);
  await expect(page.getByTestId("activity-tab-strip")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("activity-tab-strip").getByRole("tab", { name: "Fleet" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/activity/fleet"), {
    timeout: 20_000,
  });
  // Phase 4 shell (EmptyState, not a heading): assert the page loaded — its
  // title text is visible and no error boundary / 404 rendered — without
  // asserting on content Phase 4 owns.
  await expect(page.getByText(/error|something went wrong/i)).toHaveCount(0);
  await expect(page.getByText("Fleet", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "activity-tab-fleet.png"),
    fullPage: true,
  });
});
