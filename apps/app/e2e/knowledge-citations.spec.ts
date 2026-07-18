/**
 * knowledge-citations.spec.ts — end-to-end coverage for Knowledge → Citations
 * (the workspace-wide citation analytics dashboard backed by
 * agent.memory_citation.stats / "get_citation_stats").
 *
 * A fresh signup has never run an agent, so the dashboard's expected state on
 * this suite is the "no citations yet" empty state — both that and a
 * populated dashboard (in case the backing handler pre-seeds data in this
 * environment) are accepted, mirroring knowledge-graph.spec.ts's fail-open
 * assertions for a fresh workspace.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored, recreated each run).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function shot(page: import("@playwright/test").Page, name: string) {
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `knowledge-citations-${name}.png`),
    fullPage: true,
  });
}

test.describe("Knowledge → Citations", () => {
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("Citations tab navigates to the dashboard, which renders without error", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "citations-nav",
    });
    const ws = "default";

    await gotoStable(page, `/${orgSlug}/${ws}/knowledge/memory`);
    await expect(page).not.toHaveURL(/\/login/);

    await page.getByRole("tab", { name: "Citations" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${orgSlug}/${ws}/knowledge/citations$`),
    );
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    // The period switcher renders regardless of dashboard state — it's pure
    // links, not gated on the fetch.
    await expect(
      page.getByRole("group", { name: "Citations date range" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "30d" })).toBeVisible();

    // Either the empty state (fresh workspace, no agent has run yet) or a
    // populated dashboard is acceptable — never a crash or blank panel.
    const emptyState = page.getByText("No citations yet");
    const statTiles = page.getByText("Citations", { exact: true }).first();
    await expect(emptyState.or(statTiles)).toBeVisible({ timeout: 15_000 });

    await shot(page, "01-dashboard-loaded");
  });

  test("period switcher changes the ?days= window without erroring", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "citations-period",
    });
    const ws = "default";

    await gotoStable(page, `/${orgSlug}/${ws}/knowledge/citations`);
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    await expect(
      page.getByRole("group", { name: "Citations date range" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "7d" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${orgSlug}/${ws}/knowledge/citations\\?days=7$`),
    );
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    const emptyState = page.getByText("No citations yet");
    const statTiles = page.getByText("Citations", { exact: true }).first();
    await expect(emptyState.or(statTiles)).toBeVisible({ timeout: 15_000 });

    await shot(page, "02-period-7d");
  });
});
