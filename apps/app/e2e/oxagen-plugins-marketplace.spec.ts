/**
 * oxagen-plugins-marketplace.spec.ts
 *
 * Money-path E2E: Oxagen Plugins marketplace tab — install a capability pack,
 * assert it appears in org listings (disabled), then enable it.
 *
 * Flow:
 *   1. Sign up a fresh user + org (real /signup form).
 *   2. Navigate to /{orgSlug}/settings/plugins.
 *   3. Open the Plugin Marketplace modal.
 *   4. Switch to the "Oxagen Plugins" tab.
 *   5. Assert all four Phase 1 packs render with tier badges.
 *   6. Install "oxagen/media-svg".
 *   7. Assert the plugin appears in the org listings table (disabled).
 *   8. Enable the plugin via the toggle.
 *   9. Assert it is now enabled.
 *
 * Screenshots are captured at the Oxagen Plugins tab view and the installed+enabled state.
 * The screenshot directory is recreated on each run (per CLAUDE.md convention).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
);

// Recreate the screenshots directory on each run (CLAUDE.md convention).
test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("oxagen plugins marketplace — install + enable flow", () => {
  test("open marketplace → Oxagen Plugins tab → install oxagen/media-svg → assert listing → enable", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // ── 1. Fresh user + org ────────────────────────────────────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "plugins-e2e" });

    // ── 2. Navigate to org plugins settings ────────────────────────────────
    await page.goto(`/${orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Wait for the installed plugins section to render.
    await expect(page.getByText(/installed plugins/i)).toBeVisible({ timeout: 15_000 });

    // ── 3. Open marketplace ────────────────────────────────────────────────
    const browseBtn = page.getByTestId("browse-marketplace-btn");
    await expect(browseBtn).toBeVisible({ timeout: 10_000 });
    await browseBtn.click();

    await expect(page.getByTestId("marketplace-modal")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Plugin Marketplace")).toBeVisible();

    // ── 4. Switch to Oxagen Plugins tab ────────────────────────────────────
    const capabilityTab = page.getByTestId("marketplace-tab-capability");
    await expect(capabilityTab).toBeVisible({ timeout: 5_000 });
    await capabilityTab.click();

    // Wait for the capability packs to load.
    await expect(page.getByTestId("marketplace-panel-capability")).toBeVisible();

    // Screenshot: the Oxagen Plugins tab with all packs rendered.
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-oxagen-plugins-tab.png"),
      fullPage: false,
    });

    // ── 5. Assert all four Phase 1 packs render with tier badges ───────────
    // The packs are: oxagen/media-video (premium), oxagen/media-image (free),
    // oxagen/media-svg (free), oxagen/documents (free).
    await expect(page.getByTestId("marketplace-server-card-oxagen/media-svg")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("marketplace-server-card-oxagen/media-image")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("marketplace-server-card-oxagen/media-video")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("marketplace-server-card-oxagen/documents")).toBeVisible({
      timeout: 5_000,
    });

    // Tier is no longer surfaced on the marketplace cards (they show category
    // badges instead); the tier badge now lives in the detail panel, asserted
    // below via plugin-detail-tier-badge once the card is opened.

    // ── 6. Install oxagen/media-svg via the detail panel ───────────────────
    await page.getByTestId("marketplace-server-card-oxagen/media-svg").click();
    await expect(page.getByTestId("marketplace-detail-panel")).toBeVisible({ timeout: 5_000 });

    // The detail panel for capability entries shows the tier badge and no README section.
    await expect(page.getByTestId("plugin-detail-tier-badge")).toBeVisible();
    await expect(page.getByTestId("plugin-detail-tier-badge")).toHaveText("Free");
    // README is hidden for capability entries — plugin-detail-no-readme is NOT present.
    await expect(page.getByTestId("plugin-detail-readme")).not.toBeVisible();

    // Click install.
    const installBtn = page.getByTestId("plugin-detail-install-btn");
    await expect(installBtn).toBeVisible({ timeout: 5_000 });
    await expect(installBtn).not.toBeDisabled();
    await installBtn.click();

    // Modal closes after successful install.
    await expect(page.getByTestId("marketplace-modal")).not.toBeVisible({ timeout: 15_000 });

    // ── 7. Assert the plugin appears in org listings (disabled by default) ──
    // The page revalidates on install — wait for the listing row to appear.
    await expect(page.getByText("SVG Generation")).toBeVisible({ timeout: 15_000 });

    // Find the listing row for oxagen/media-svg and assert it is disabled.
    // The toggle is in the row; we find the row by display name and check the Switch.
    const listingRows = page.locator('[data-testid^="org-listing-row-"]');
    const svgRow = listingRows.filter({ hasText: "SVG Generation" });
    await expect(svgRow).toBeVisible({ timeout: 10_000 });

    const toggle = svgRow.locator('[data-testid^="org-listing-enable-toggle-"]');
    // checked=false (aria-checked="false") means disabled.
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Screenshot: installed listing in disabled state.
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-oxagen-plugin-installed-disabled.png"),
      fullPage: false,
    });

    // ── 8. Enable the plugin ────────────────────────────────────────────────
    await toggle.click();

    // ── 9. Assert enabled ──────────────────────────────────────────────────
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });

    // Screenshot: installed listing in enabled state.
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-oxagen-plugin-enabled.png"),
      fullPage: false,
    });
  });
});
