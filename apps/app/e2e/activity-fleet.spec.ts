/**
 * activity-fleet.spec.ts
 *
 * E2E coverage for the Activity → Fleet surface (subagent fan-out
 * observability). A fresh org has never dispatched a subagent fan-out, so
 * this spec proves the empty state — the list, detail (?fanout=<id>), cancel,
 * and child-drawer flows all require a real fan-out row to exist, which is
 * out of reach for a fresh signup (agent.subagent.dispatch is triggered by an
 * agent definition using subagent dispatch, not by anything in the signup
 * flow). Mirrors the "empty state acceptable" scope called out in the Fleet
 * build task.
 *
 * NOTE: needs the full local datastore stack (Postgres :5433 et al. via
 * `pnpm dev`) and the app dev server. Authored against the real UI but not
 * run by this agent (see CLAUDE.md — subagents author, they don't execute
 * whole-suite/e2e runs).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";

test.describe("activity/fleet — empty state", () => {
  test("a fresh workspace with no fan-outs shows the Fleet empty state", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "fleet" });

    await page.goto(`/${orgSlug}/default/activity/fleet`);
    await expect(page).not.toHaveURL(/\/login/);

    await expect(page.getByTestId("fleet-page")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Fleet", { exact: true })).toBeVisible();

    await expect(page.getByTestId("fleet-empty-state")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/no fan-outs yet/i)).toBeVisible();
    await expect(page.getByText(/subagent dispatch/i)).toBeVisible();

    // No fan-out rows and no stray error state — a clean, working empty page.
    await expect(page.locator('[data-testid^="fleet-row-"]')).toHaveCount(0);
    await expect(page.getByTestId("fleet-detail-not-found")).toHaveCount(0);
  });

  test("navigating with a stale ?fanout= query param shows the not-found detail state, not a crash", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "fleet-nf" });

    await page.goto(`/${orgSlug}/default/activity/fleet?fanout=fo_does_not_exist`);
    await expect(page).not.toHaveURL(/\/login/);

    await expect(page.getByTestId("fleet-page")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("fleet-detail-not-found")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/fan-out not found/i)).toBeVisible();
  });
});
