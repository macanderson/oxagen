/**
 * automations-triggers.spec.ts
 *
 * E2E for the workspace-wide Triggers board
 * (`/{orgSlug}/{workspaceSlug}/automations/triggers`):
 *   1. The page renders under the Automations · Triggers · Workflows tab
 *      strip, with the Triggers tab active.
 *   2. A fresh workspace with no agent triggers configured shows the empty
 *      state ("No triggers configured across any agent yet.") rather than an
 *      error or a blank page.
 *   3. Creating an agent + a manual trigger via the "New trigger" dialog makes
 *      it show up in the table, with the agent name, type badge, and enabled
 *      state rendered.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots", "automations-triggers");

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("Triggers board", () => {
  test("renders under the Automations tab strip with the empty state", async ({ page }) => {
    test.setTimeout(120_000);

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "triggers-empty" });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/automations/triggers`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(/\/automations\/triggers$/);

    // Tab strip: Automations · Triggers · Workflows, all present, no fork of
    // it in this page.
    for (const label of ["Automations", "Triggers", "Workflows"]) {
      await expect(
        page.getByRole("tab", { name: label }).or(page.getByRole("link", { name: label })).first(),
      ).toBeVisible({ timeout: 20_000 });
    }

    // A brand-new workspace has zero agents/triggers — the empty state, not
    // an error banner or a blank screen.
    await expect(page.getByText("No triggers configured across any agent yet.")).toBeVisible({
      timeout: 20_000,
    });
    // Never the whole-fan-out error banner on a legitimately empty board.
    await expect(page.getByText(/Couldn.t load the trigger board/)).toHaveCount(0);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-triggers-empty-state.png"),
      fullPage: true,
    });
  });

  test("create an agent, then a manual trigger from the board — it shows up in the table", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "triggers-create" });
    const ws = `/${orgSlug}/default`;

    // Create an agent first — the Triggers board's Create dialog only offers
    // agents that already exist (agent.trigger.create needs an agentId).
    // Same builder flow as agents-card-grid-avatars.spec.ts: Describe (skip)
    // → Identity (name + slug) → jump to Review → Save draft. A draft agent
    // is still eligible in the Triggers board's agent picker (only
    // product-managed agents are excluded — see listAgentOptions).
    await gotoStable(page, `${ws}/workbench/agents/new`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("step-describe")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("agent-describe-skip").click();
    await expect(page.getByTestId("step-identity")).toBeVisible();

    // Agent slugs are capped at 18 chars (agent.definition.create's slug.max(18)),
    // so keep a short prefix — `e2e-trg-` + an ~8-char base36 timestamp ≈ 16 chars.
    const slug = `e2e-trg-${Date.now().toString(36)}`;
    await page.getByTestId("agent-name-input").fill("Trigger Board Test Agent");
    await page.getByTestId("agent-slug-input").fill(slug);
    await page.getByTestId("builder-step-review").click();
    await expect(page.getByTestId("step-review")).toBeVisible();
    await page.getByTestId("agent-save-draft").click();
    await expect(page.getByText(/draft saved/i)).toBeVisible({ timeout: 20_000 });

    // ── Triggers board ───────────────────────────────────────────────────
    await gotoStable(page, `${ws}/automations/triggers`);
    await expect(page.getByTestId("new-trigger")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("new-trigger").click();

    await expect(page.getByTestId("trigger-agent-select")).toBeVisible({ timeout: 15_000 });
    // Default type is "manual" — no extra config required, just submit.
    await page.getByTestId("trigger-form-submit").click();

    // Dialog closes and the new row renders in the table.
    await expect(page.getByTestId("trigger-form-submit")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("triggers-table")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Trigger Board Test Agent")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Manual").first()).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-triggers-table-with-row.png"),
      fullPage: true,
    });
  });
});
