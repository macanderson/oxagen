/**
 * subagent-fanout-viewer.spec.ts — end-to-end coverage for the subagent
 * fan-out viewer (the in-app "agent monitor").
 *
 * Drives the real UI against the running app + API + Postgres stack:
 *   1. Sign up a fresh owner → open the Subagent Runs viewer via the sidebar.
 *   2. See the empty state (no fan-outs dispatched yet).
 *   3. Navigate directly to a non-existent fan-out → notFound (404) page.
 *
 * Live fan-out data requires a chat-dispatched fan-out + the Inngest runner, so
 * the deeper "watch a running fan-out" assertions are exercised by the unit
 * tests (fanout-list/detail) — this spec proves the route, nav, auth, and empty
 * state render end-to-end.
 *
 * Screenshots of key states go to apps/app/e2e/screenshots/ (gitignored).
 * The directory is deleted + recreated at the start of the run.
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

function shot(page: import("@playwright/test").Page, name: string) {
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `subagent-fanout-${name}.png`),
    fullPage: true,
  });
}

test.describe("subagent fan-out viewer", () => {
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("empty state → sidebar nav → missing fan-out 404", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "fanout" });
    const ws = "default";

    // ── 1. Direct navigation to the viewer ──────────────────────────────────
    await page.goto(`/${orgSlug}/${ws}/agents/runs`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(/no subagent fan-outs yet/i)).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-empty");

    // ── 2. Reach it from the sidebar ────────────────────────────────────────
    await page.getByRole("link", { name: /subagent runs/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${ws}/agents/runs$`));
    await shot(page, "02-from-sidebar");

    // ── 3. A non-existent fan-out renders the notFound page ──────────────────
    const res = await page.goto(`/${orgSlug}/${ws}/agents/runs/fan_does_not_exist`);
    expect(res?.status()).toBe(404);
    await shot(page, "03-not-found");
  });
});
