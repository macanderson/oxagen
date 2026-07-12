import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

test("workspace overview: renders spend, runs, graph, and sources tiles in their zero states", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "e2e-overview" });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // signUpFreshUser's default workspace slug is always "default".
  await gotoStable(page, `/${orgSlug}/default`);
  await expect(page).not.toHaveURL(/\/login/);

  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible({
    timeout: 20_000,
  });

  const spendTile = page.getByTestId("overview-spend-tile");
  const runsTile = page.getByTestId("overview-runs-tile");
  const graphTile = page.getByTestId("overview-graph-tile");
  const sourcesTile = page.getByTestId("overview-sources-tile");
  const reviewLinks = page.getByTestId("overview-review-links");

  await expect(spendTile).toBeVisible({ timeout: 20_000 });
  await expect(runsTile).toBeVisible();
  await expect(graphTile).toBeVisible();
  await expect(sourcesTile).toBeVisible();
  await expect(reviewLinks).toBeVisible();

  // Fresh org + workspace ⇒ no spend, no runs, no connections yet.
  await expect(spendTile.getByText(/no spend yet/i)).toBeVisible();
  await expect(runsTile.getByText(/no runs yet/i)).toBeVisible();
  await expect(graphTile.getByText(/no graph data yet/i)).toBeVisible();
  await expect(sourcesTile.getByText(/no sources connected yet/i)).toBeVisible();

  // The "Needs attention" quick links are always present (static, not data-driven).
  await expect(reviewLinks.getByRole("link", { name: /review inferred edges/i })).toBeVisible();
  await expect(reviewLinks.getByRole("link", { name: /review memories/i })).toBeVisible();
  await expect(reviewLinks.getByRole("link", { name: /open ask/i })).toBeVisible();

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "workspace-overview.png"), fullPage: true });

  // The runs tile's footer link navigates to Activity.
  await runsTile.getByRole("link", { name: /view all runs/i }).click();
  await expect(page).toHaveURL(new RegExp(`/${orgSlug}/default/activity$`), { timeout: 20_000 });
});
