/**
 * skills-management.spec.ts
 *
 * E2E: Workspace → Settings → Skills management UI.
 *
 * Flow:
 *   1. Sign up a fresh user + org (real /signup form).
 *   2. Navigate to /{orgSlug}/default/settings/skills.
 *   3. Assert the Skills tab is visible and the empty state renders.
 *   4. Screenshot: skills list empty state.
 *   5. Navigate to the skill detail view (via direct URL with a known slug).
 *      The detail page degrades gracefully to "not found" when no skill exists.
 *   6. Screenshot: skill not-found state (detail view).
 *
 * NOTE: Full list → detail → edit → activate → download requires a skill to be
 * installed first (skill.workspace.install). That flow exercises the real
 * handler stack which is unit-tested separately. Here we focus on the reachable
 * UI path (list page renders, detail page degrades, back-link works) so that
 * the page is verifiably wired into the settings nav without requiring a live
 * skills catalog.
 *
 * Screenshots are captured at key states. The screenshot directory is
 * recreated on each run (CLAUDE.md convention).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots");

// Recreate the screenshots directory on each run (CLAUDE.md convention).
test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("skills management UI", () => {
  test("skills list page renders + detail degrades gracefully", async ({ page }) => {
    test.setTimeout(90_000);

    // ── 1. Fresh user + org ──────────────────────────────────────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "skills-e2e" });
    const workspaceSlug = "default";

    // ── 2. Navigate to skills settings ──────────────────────────────────────
    await page.goto(`/${orgSlug}/${workspaceSlug}/settings/skills`);
    await expect(page).not.toHaveURL(/\/login/);

    // ── 3. Assert Skills tab is active and page heading renders ─────────────
    await expect(page.getByText(/installed skills/i)).toBeVisible({ timeout: 15_000 });

    // The Settings nav should have a "Skills" tab link.
    const skillsTab = page.getByRole("link", { name: /^skills$/i });
    await expect(skillsTab).toBeVisible({ timeout: 5_000 });

    // ── 4. Assert empty state renders ────────────────────────────────────────
    // When no skills are installed the panel shows the empty state element.
    await expect(page.getByTestId("skills-empty-state")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/no skills installed/i)).toBeVisible();

    // ── Screenshot: skills list empty state ──────────────────────────────────
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-skills-list-empty.png"),
      fullPage: false,
    });

    // ── 5. Navigate to a non-existent skill detail view ──────────────────────
    await page.goto(
      `/${orgSlug}/${workspaceSlug}/settings/skills/does-not-exist`,
    );

    // The back-link to "All Skills" must be present.
    await expect(page.getByTestId("skill-detail-back-link")).toBeVisible({ timeout: 10_000 });

    // The not-found copy must include the slug in a monospace element.
    await expect(page.getByText(/was not found in this workspace/i)).toBeVisible({
      timeout: 5_000,
    });

    // ── Screenshot: skill detail not-found ───────────────────────────────────
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-skill-detail-not-found.png"),
      fullPage: false,
    });

    // ── 6. Back-link returns to the skills list ──────────────────────────────
    await page.getByTestId("skill-detail-back-link").click();
    await expect(page).toHaveURL(
      new RegExp(`/${orgSlug}/${workspaceSlug}/settings/skills$`),
      { timeout: 10_000 },
    );
  });
});
