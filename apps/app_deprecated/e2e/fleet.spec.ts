/**
 * fleet.spec.ts — the runtime proof behind the `list_tacho_hosts` binding in
 * `apps/app/capability-ui-map.json`.
 *
 * It asserts the Fleet page renders without an error page for a fresh org and
 * that the honesty rule ADR-078 turns on survives into the UI: the page
 * explains both tiers, and it never ranks them against each other. A fresh org
 * has no enrolled machines, so this drives the empty state — which is what
 * every customer sees first, and the state where a screen is most likely to
 * overclaim.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, "screenshots", "fleet");

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("fleet: renders, explains both tiers, and ranks neither", async ({
  page,
}) => {
  test.setTimeout(90_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "fleet" });

  await page.goto(`/${orgSlug}/default/fleet`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // The page rendered — not a 404, not the error boundary.
  await expect(page.getByTestId("fleet-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
  await expect(page.getByTestId("fleet-error")).toHaveCount(0);

  // `list_tacho_hosts` returned, and the empty state teaches rather than
  // showing a blank panel.
  await expect(page.getByTestId("fleet-empty")).toBeVisible();
  await expect(page.getByTestId("fleet-empty")).toContainText(
    /No machines are enrolled/i,
  );

  // Both tiers are named and distinguished, so a reader who has one of each
  // knows they are not degrees of the same thing (ADR-078 §2).
  const intro = page.getByTestId("fleet-page");
  await expect(intro).toContainText(/wrapped/i);
  await expect(intro).toContainText(/connected/i);
  await expect(intro).toContainText(/Neither covers what the other covers/i);

  // And nothing ranks them. These are the words a coverage meter would use.
  const body = (await intro.textContent()) ?? "";
  expect(body.toLowerCase()).not.toContain("fully governed");
  expect(body.toLowerCase()).not.toContain("partially governed");
  expect(body.toLowerCase()).not.toContain("coverage score");

  await page.screenshot({
    path: resolve(SCREENSHOT_DIR, "fleet-empty.png"),
    fullPage: true,
  });
});
