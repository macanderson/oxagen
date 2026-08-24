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

test("workspace overview HUD: renders every section in its zero state", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { orgSlug } = await signUpFreshUser(page, {
    orgPrefix: "e2e-overview",
  });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // signUpFreshUser's default workspace slug is always "default".
  await gotoStable(page, `/${orgSlug}/default`);
  await expect(page).not.toHaveURL(/\/login/);

  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });

  // A fresh org creator is an Owner ⇒ billing manager, so the metering strip
  // renders (with zeros) rather than the "requires billing access" card.
  const kpiStrip = page.getByTestId("overview-kpi-strip");
  const graphHero = page.getByTestId("overview-graph-hero");
  const automationsPanel = page.getByTestId("overview-automations-panel");
  const usagePanel = page.getByTestId("overview-usage-panel");
  const memoriesPanel = page.getByTestId("overview-memories-panel");
  const sourcesTile = page.getByTestId("overview-sources-tile");
  const reviewLinks = page.getByTestId("overview-review-links");

  await expect(kpiStrip).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("overview-kpi-spend")).toBeVisible();
  await expect(graphHero).toBeVisible();
  await expect(automationsPanel).toBeVisible();
  await expect(usagePanel).toBeVisible();
  await expect(memoriesPanel).toBeVisible();
  await expect(sourcesTile).toBeVisible();
  await expect(reviewLinks).toBeVisible();

  // Fresh org + workspace ⇒ empty everywhere.
  await expect(graphHero.getByText(/no graph data yet/i)).toBeVisible();
  await expect(automationsPanel.getByText(/no automations yet/i)).toBeVisible();
  await expect(usagePanel.getByText(/no usage yet/i)).toBeVisible();
  await expect(
    memoriesPanel.getByText(/no memories captured yet/i),
  ).toBeVisible();
  await expect(
    sourcesTile.getByText(/no sources connected yet/i),
  ).toBeVisible();

  // The "Needs attention" quick links are always present (static, not
  // data-driven). The current pair is Review memories / Open Sessions —
  // "review inferred edges" left with the graph-authority retirement (#1087)
  // and "ask" became Sessions; this spec pinned the old pair through the
  // weeks CI was down.
  await expect(
    reviewLinks.getByRole("link", { name: /review memories/i }),
  ).toBeVisible();
  await expect(
    reviewLinks.getByRole("link", { name: /open sessions/i }),
  ).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "workspace-overview.png"),
    fullPage: true,
  });
});
