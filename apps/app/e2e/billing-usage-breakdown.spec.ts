/**
 * billing-usage-breakdown.spec.ts — e2e for the billing.usage.breakdown dashboard.
 *
 * Drives /{orgSlug}/billing/usage for a fresh org. A brand-new org has no
 * ClickHouse usage yet, so the dashboard renders its zero/empty states — this
 * spec asserts the surface renders end-to-end (KPI cards, range picker, chart
 * toggle, and the by-model/surface/workspace panels) without crashing, that the
 * range picker updates the URL, and captures screenshots of the success state.
 *
 * The data path itself (grouped ClickHouse aggregates) is covered by the
 * telemetry/handler/route/contract unit tests; here we prove the page is wired.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, "screenshots");

test.beforeAll(() => {
  // Delete + recreate the screenshot directory on every run.
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("usage dashboard: renders KPIs, breakdown panels, and range picker for a fresh org", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "usage-dash" });

  await page.goto(`/${orgSlug}/billing/usage`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // KPI cards — the four headline measures always render (zeros for a fresh org).
  // Exact match: "Cached tokens" would otherwise also match descriptive copy.
  await expect(page.getByText("Total cost", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("Cached tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("LLM calls", { exact: true })).toBeVisible();

  // Cache-economics row — cache hit % and net savings must be surfaced.
  await expect(page.getByText("Cache hit rate", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache writes", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache savings", { exact: true })).toBeVisible();

  // Range picker present with all four presets.
  const rangePicker = page.getByRole("group", { name: /usage date range/i });
  await expect(rangePicker).toBeVisible();
  await expect(rangePicker.getByRole("link", { name: "7 days" })).toBeVisible();
  await expect(
    rangePicker.getByRole("link", { name: "30 days" }),
  ).toBeVisible();
  await expect(
    rangePicker.getByRole("link", { name: "90 days" }),
  ).toBeVisible();
  await expect(
    rangePicker.getByRole("link", { name: "Month to date" }),
  ).toBeVisible();

  // Breakdown panels render (empty-state copy for a fresh org).
  await expect(page.getByText("By model")).toBeVisible();
  await expect(page.getByText("By surface")).toBeVisible();
  await expect(page.getByText("By workspace")).toBeVisible();

  // Chart metric toggle (Cost / Tokens segmented control).
  await expect(
    page.getByRole("button", { name: /^Cost$/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Tokens$/ }).first(),
  ).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/usage-dashboard-default.png`,
    fullPage: true,
  });

  // Switch to the 7-day preset — the server re-renders with ?range=7d.
  await rangePicker.getByRole("link", { name: "7 days" }).click();
  await expect(page).toHaveURL(/[?&]range=7d/);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Total cost")).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/usage-dashboard-7d.png`,
    fullPage: true,
  });
});

test("usage dashboard: switching the chart metric to Tokens keeps the page live", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, {
    orgPrefix: "usage-toggle",
  });
  await page.goto(`/${orgSlug}/billing/usage`);
  await page.waitForLoadState("domcontentloaded");

  const tokensToggle = page.getByRole("button", { name: /^Tokens$/ }).first();
  await expect(tokensToggle).toBeVisible({ timeout: 15_000 });
  await tokensToggle.click();

  // The daily chart panel title switches to the token view.
  await expect(page.getByText("Daily tokens")).toBeVisible({ timeout: 8_000 });
});
