/**
 * spend-budgets.spec.ts — e2e for Workspace → Settings → Spend Budgets
 * (/{orgSlug}/{workspaceSlug}/settings/spend-budgets, OXA-1079).
 *
 * Drives the page for a fresh org (whose creator is an owner = billing
 * manager) on its default workspace. A brand-new workspace has no ceilings
 * configured for either scope, so this proves both empty states render, then
 * exercises the primary "set a ceiling" flow for the workspace scope and
 * asserts the saved values render back.
 *
 * The gate/evaluator logic (rolling vs monthly, threshold ladder, denial) is
 * covered by the billing package unit tests and actions.test.ts; here we
 * prove the app surface is wired and works end-to-end.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Per-spec subdirectory, NOT the shared `e2e/screenshots` root: the beforeAll
// below wipes this directory, and pointing several specs at the same root made
// each one delete the artifacts the previously-run specs had just captured.
const SCREENSHOT_DIR = resolve(__dirname, "screenshots", "spend-budgets");

test.beforeAll(() => {
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test("spend budgets: renders both scope cards with empty states for a fresh workspace", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "spendbud" });
  const ws = `/${orgSlug}/default`;

  await gotoStable(page, `${ws}/settings/spend-budgets`);
  await expect(page).not.toHaveURL(/\/login/);

  await expect(page.getByText("Spend budgets", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Both scope cards render — never a blank or missing scope.
  await expect(page.getByTestId("spend-budget-org-card")).toBeVisible();
  await expect(page.getByTestId("spend-budget-workspace-card")).toBeVisible();

  // Fresh workspace: neither scope has a configured ceiling yet.
  await expect(page.getByTestId("spend-budget-org-empty")).toBeVisible();
  await expect(page.getByTestId("spend-budget-workspace-empty")).toBeVisible();
  await expect(page.getByText("No ceiling configured").first()).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/spend-budgets-empty.png`,
    fullPage: true,
  });
});

test("spend budgets: set a workspace ceiling and see it reflected on the card", async ({
  page,
}) => {
  test.setTimeout(60_000);

  const { orgSlug } = await signUpFreshUser(page, {
    orgPrefix: "spendbud-set",
  });
  const ws = `/${orgSlug}/default`;

  await gotoStable(page, `${ws}/settings/spend-budgets`);
  await expect(page.getByTestId("spend-budget-workspace-card")).toBeVisible();

  // Open the workspace scope's "set a ceiling" form.
  await page.getByTestId("spend-budget-workspace-set-button").click();
  await expect(page.getByTestId("spend-budget-workspace-form")).toBeVisible();

  await page.getByTestId("spend-budget-workspace-limit-input").fill("250");
  await page.getByTestId("spend-budget-workspace-save").click();

  // The card leaves the empty state and shows the configured ceiling.
  await expect(page.getByTestId("spend-budget-workspace-empty")).toHaveCount(
    0,
    {
      timeout: 15_000,
    },
  );
  await expect(page.getByTestId("spend-budget-workspace-state")).toBeVisible();
  await expect(page.getByText("$250.00")).toBeVisible();

  // The org scope is unaffected — still shows its own empty state.
  await expect(page.getByTestId("spend-budget-org-empty")).toBeVisible();

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/spend-budgets-workspace-set.png`,
    fullPage: true,
  });
});
