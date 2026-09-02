/**
 * governance.spec.ts — e2e for the org Governance surface: the Capability &
 * Contract catalog (/{orgSlug}/governance/capabilities) and the Policies page
 * (/{orgSlug}/governance/policies).
 *
 * Drives both pages for a fresh org whose creator is an owner. The capability
 * registry is process-global so the catalog always has rows; a brand-new org
 * has no custom roles, auth alerts, or audit events, so the policies page
 * proves its read chain (list_iam_roles, get_auth_alerts, query_audit_log)
 * renders end-to-end without erroring. Opening a catalog row exercises the
 * get_capability_registry drawer read. The write path (set_auth_alerts) is
 * covered by the policies actions unit test; here we prove the surface is wired.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Per-spec subdirectory, NOT the shared `e2e/screenshots` root: the beforeAll
// below wipes this directory, and pointing several specs at the same root made
// each one delete the artifacts the previously-run specs had just captured.
const SCREENSHOT_DIR = resolve(__dirname, "screenshots", "governance");

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("governance: capability catalog renders + row drawer opens", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "gov" });

  await page.goto(`/${orgSlug}/governance/capabilities`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // The registry read succeeded (not the full-page error state) and rendered rows.
  await expect(page.getByTestId("capability-catalog")).toBeVisible({
    timeout: 20_000,
  });
  const firstRow = page.locator('[data-testid^="capability-row-"]').first();
  await expect(firstRow).toBeVisible({ timeout: 15_000 });

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governance-capabilities.png`,
    fullPage: true,
  });

  // Opening a row loads the contract detail drawer (get_capability_registry).
  await firstRow.click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
});

test("governance: policies page renders roles + auth alerts for a fresh org", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "gov" });

  await page.goto(`/${orgSlug}/governance/policies`);
  await expect(page).not.toHaveURL(/\/login/);
  await page.waitForLoadState("domcontentloaded");

  // Page container + the always-present MCP auth-alerts panel render, proving
  // the server read chain (list_iam_roles, get_auth_alerts, query_audit_log)
  // resolved without throwing into the route error boundary.
  await expect(page.getByTestId("governance-policies")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("auth-alerts-panel")).toBeVisible({
    timeout: 15_000,
  });

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governance-policies.png`,
    fullPage: true,
  });
});
