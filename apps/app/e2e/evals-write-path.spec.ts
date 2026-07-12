/**
 * evals-write-path — e2e spec for the Workspace → Evals write path (web-app-2.0
 * Phase 1). Signs up a fresh user (owner of a new org + default workspace),
 * then drives:
 *   1. /{org}/{ws}/evals with a fresh workspace — the empty state renders with
 *      a "New dataset" CTA.
 *   2. New dataset → Manual mode → create "Smoke dataset" → the dataset card
 *      appears in the list.
 *   3. Open the dataset card's detail drawer → Add item (input/expected) →
 *      the item appears and the item count increments.
 *   4. The Run eval launcher renders and validates — this spec does NOT
 *      assert a successful run completion (it would consume real LLM tokens
 *      and may not finish inside a CI-shaped timeout); it accepts either a
 *      runId status chip or a graceful error toast, and only asserts the UI
 *      never crashes either way.
 *
 * Screenshots are written to a dedicated sub-directory under e2e/screenshots/,
 * recreated on each run (CLAUDE.md convention) so this spec never races the
 * shared screenshots dir under fullyParallel.
 *
 * NOTE: this spec needs the full local datastore stack (Postgres :5433 et al.
 * via `pnpm dev`) and the app dev server — it is not expected to run in a
 * bare CI/agent shell without that stack.
 */

import { test, expect } from "@playwright/test";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";

const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots", "evals-write-path");

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("evals — write path", () => {
  test("creates a dataset, adds an item, and renders the run launcher", async ({ page }) => {
    test.setTimeout(120_000);

    // ── 1. Fresh user + org (owner of the default workspace) ────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "evals-write" });

    // ── 2. Navigate to the workspace Evals page — fresh workspace, empty ────
    await gotoStable(page, `/${orgSlug}/default/evals`);
    await expect(page.getByRole("heading", { name: "Evals", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("evals-datasets-empty-state")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("evals-new-dataset")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-empty-state.png"),
      fullPage: true,
    });

    // ── 3. New dataset → Manual mode → create ────────────────────────────────
    await page.getByTestId("evals-new-dataset").click();
    await expect(page.getByRole("heading", { name: "New dataset" })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByLabel("Name").fill("Smoke dataset");
    await page.getByTestId("evals-create-manual-submit").click();

    // The drawer closes and the dataset card appears once the RSC list
    // re-fetches (router.refresh() inside the form's submit handler).
    const datasetCard = page.getByTestId("dataset-card-smoke-dataset");
    await expect(datasetCard).toBeVisible({ timeout: 20_000 });
    await expect(datasetCard).toContainText("0 items");

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-dataset-created.png"),
      fullPage: true,
    });

    // ── 4. Open the dataset detail drawer → Add item ─────────────────────────
    await datasetCard.click();
    const drawer = page.getByTestId("evals-dataset-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Smoke dataset" })).toBeVisible();

    await page.getByLabel("Input").fill("What is 2+2?");
    await page.getByLabel("Expected output (optional)").fill("4");
    await page.getByTestId("evals-add-item-submit").click();

    await expect(page.getByTestId("evals-dataset-item").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(drawer.getByText("Items (1)")).toBeVisible({ timeout: 20_000 });
    await expect(drawer.getByText("What is 2+2?")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-item-added.png"),
      fullPage: true,
    });

    // ── 5. Run eval launcher renders + validates ─────────────────────────────
    await expect(page.getByRole("heading", { name: "Run eval" })).toBeVisible();
    const runButton = page.getByTestId("evals-run-start");
    await expect(runButton).toBeVisible();

    // Agent target requires an agent slug — submitting without one shows an
    // inline validation error and must not crash the page. The segmented
    // control (Base UI ToggleGroup) renders plain buttons with aria-pressed,
    // not role="radio" — scope to the drawer to avoid ambiguity.
    await drawer.getByRole("button", { name: "Agent", exact: true }).click();
    await runButton.click();
    await expect(page.getByText(/agent slug is required/i)).toBeVisible({ timeout: 10_000 });

    // Switch back to the model target (optional field, always valid) and
    // submit. This DOES call eval.run.start for real — accept either a
    // runId status chip or a graceful error toast (e.g. insufficient
    // balance); either way the page must not crash.
    await drawer.getByRole("button", { name: "Model", exact: true }).click();
    await runButton.click();

    const runStatus = page.getByTestId("evals-run-status");
    const errorAlert = drawer.getByRole("alert").last();
    await expect(runStatus.or(errorAlert)).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("heading", { name: "Evals" })).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-run-launcher.png"),
      fullPage: true,
    });
  });
});
