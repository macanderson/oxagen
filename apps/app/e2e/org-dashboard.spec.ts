/**
 * org-dashboard.spec.ts — e2e for the org dashboard + the Ask→Sessions rename.
 *
 * Covers, for a fresh org (no ClickHouse usage yet, so the dashboard renders its
 * zero/empty states — this proves the surfaces are WIRED, not the numbers):
 *
 *   1. The org root `/{org}` 307-redirects to `/{org}/dashboard` (the new home).
 *   2. The dashboard renders the core stat strip, the capability/usage panels,
 *      and the range picker; the range picker updates the URL.
 *   3. The workspace chat surface is now `/sessions`: the legacy `/ask` (and
 *      `/chat`) URLs 301-redirect to `/sessions`, and the Sessions page loads.
 *
 * The aggregation path (grouped ClickHouse token_usage, incl. byUser + messages)
 * is covered by the telemetry/handler/contract unit tests; here we prove the
 * pages are wired end-to-end and capture screenshots of the success state.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, "screenshots");

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("org root redirects to the dashboard and renders the usage cockpit", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "org-dash" });

  // 1. The org root lands on the dashboard.
  await page.goto(`/${orgSlug}`);
  await expect(page).toHaveURL(new RegExp(`/${orgSlug}/dashboard$`), {
    timeout: 15_000,
  });
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // 2. Header + core stat strip (zeros for a fresh org).
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Executions", { exact: true })).toBeVisible();
  await expect(page.getByText("Chat turns", { exact: true })).toBeVisible();
  await expect(page.getByText("Total tokens", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Cache-read share", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Capabilities used", { exact: true }),
  ).toBeVisible();

  // Reused breakdown panels.
  await expect(page.getByText("By model")).toBeVisible();
  await expect(page.getByText("By surface")).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/org-dashboard-default.png`,
    fullPage: true,
  });

  // 3. Range picker updates the URL (server re-render with ?range=7d).
  const rangePicker = page.getByRole("group", { name: /usage date range/i });
  await expect(rangePicker).toBeVisible();
  await rangePicker.getByRole("link", { name: "7 days" }).click();
  await expect(page).toHaveURL(/[?&]range=7d/);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("workspace chat surface is Sessions: /ask and /chat redirect to /sessions", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "sessions" });
  const ws = "default";

  // Legacy /ask → /sessions (301, query preserved elsewhere; bare here).
  await page.goto(`/${orgSlug}/${ws}/ask`);
  await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${ws}/sessions`), {
    timeout: 15_000,
  });
  await expect(page).not.toHaveURL(/\/login/);

  // Legacy /chat → /sessions too.
  await page.goto(`/${orgSlug}/${ws}/chat`);
  await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${ws}/sessions`), {
    timeout: 15_000,
  });

  // The Sessions page itself loads (the conversational front door) without
  // crashing — a chat composer textbox is the stable success marker. The
  // "No session" label (renamed from "New conversation") is unit-covered
  // (conversation-item / conversation-list tests).
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("textbox").first()).toBeVisible({
    timeout: 15_000,
  });

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/sessions-surface.png`,
    fullPage: true,
  });
});
