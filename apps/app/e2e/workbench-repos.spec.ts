/**
 * workbench-repos — e2e for the Workbench → Repos list + detail surface.
 *
 * A fresh workspace has no GitHub connections (installing the Oxagen GitHub
 * App requires a live OAuth round-trip this harness can't drive), so this
 * spec covers what's honestly reachable without stubbing:
 *   1. The list page renders its header actions and the empty state.
 *   2. Direct navigation to a repo detail URL for an id that doesn't belong
 *      to this workspace 404s (list_connections is tenant-scoped — proves
 *      the notFound() wiring end-to-end, matching the "belongs to another
 *      workspace → notFound()" requirement).
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

test("Repos list renders the empty state without the toolbar; an unknown repo id 404s", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-repos" });

  // ── 1. List page ───────────────────────────────────────────────────────
  await gotoStable(page, `/${user.orgSlug}/default/workbench/repos`);

  await expect(page.getByRole("heading", { name: "Repos" })).toBeVisible({
    timeout: 20_000,
  });

  // No GitHub connections in a fresh workspace → the empty state, not a table.
  await expect(page.getByTestId("repos-empty-state")).toBeVisible();
  await expect(page.getByTestId("repos-table")).toHaveCount(0);

  // With zero repos the top toolbar is deliberately absent: Refresh, Fork and
  // Edit file have nothing to act on, so repos-client.tsx gates the whole strip
  // on `repos.length > 0` and offers Create inside the empty card instead. The
  // unit test "hides the inoperable toolbar and puts Create repo inside the
  // empty state" pins the same contract. Asserting the absence keeps this spec
  // honest about which of the two Create buttons a fresh workspace gets.
  await expect(page.getByTestId("repos-empty-create-btn")).toBeVisible();
  await expect(page.getByTestId("repos-create-btn")).toHaveCount(0);
  await expect(page.getByTestId("repos-fork-btn")).toHaveCount(0);
  await expect(page.getByTestId("repos-edit-file-btn")).toHaveCount(0);
  await expect(page.getByTestId("repos-refresh-btn")).toHaveCount(0);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "workbench-repos-empty.png"),
    fullPage: true,
  });

  // ── 2. Detail page — an id from another workspace (or nonexistent) 404s ──
  await gotoStable(
    page,
    `/${user.orgSlug}/default/workbench/repos/con_doesnotexist`,
  );
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible({
    timeout: 20_000,
  });

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "workbench-repo-detail-404.png"),
    fullPage: true,
  });
});
