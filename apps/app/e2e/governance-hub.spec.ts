/**
 * governance-hub.spec.ts — e2e for the Governance hub
 * (/{orgSlug}/governance).
 *
 * The capability catalog and policies pages have their own coverage in
 * governance.spec.ts. This spec is narrower: it exists specifically to prove
 * the hub's audit-log read (query_audit_log) — the hub is the ONLY governance
 * page that invokes query_audit_log (capabilities/policies invoke
 * list_capability_registry / get_capability_registry / list_iam_roles /
 * get_auth_alerts, not query_audit_log) — so a spec that never navigates to
 * the hub is not real proof for that capability.
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

test("governance hub: renders the accountability-chain cards and audit feed for a fresh org", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "gov-hub" });

  await page.goto(`/${orgSlug}/governance`);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("governance-hub")).toBeVisible({
    timeout: 15_000,
  });

  // Summary tiles always render (zero-state for a fresh org).
  await expect(
    page.getByText("Active contracts", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Audit events", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Denied invocations", { exact: true }),
  ).toBeVisible();

  // The six accountability-chain cards.
  await expect(page.getByText("Identity", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Knowledge scope", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Permitted action", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Commercial terms", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Verified outcome", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Audit record", { exact: true })).toBeVisible();

  // A fresh org has no denied invocations — the all-clear state proves the
  // query_audit_log read completed successfully (not degraded to null).
  await expect(page.getByTestId("denied-all-clear")).toBeVisible({
    timeout: 10_000,
  });

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/governance-hub.png`,
    fullPage: true,
  });
});
