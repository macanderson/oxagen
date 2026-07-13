/**
 * evals-write-path — e2e spec for the Workspace → Evals write path (unified
 * redesign). Signs up a fresh user (owner of a new org + default workspace),
 * then drives the drawer-free, page-based flow:
 *   1. /{org}/{ws}/evals with a fresh workspace — the empty state renders with
 *      a "New dataset" CTA.
 *   2. New dataset → Dialog → Manual mode → create "Smoke dataset" → the
 *      dataset card appears in the list.
 *   3. Click the dataset card → NAVIGATE to the full dataset detail page
 *      (/evals/datasets/{id}) — no drawer. The header, stat row, and tab strip
 *      (Runs / Run setup / Items) render.
 *   4. Items tab → Add item (input/expected) → the item appears and the item
 *      count increments.
 *   5. Run setup tab → the run launcher renders with provider/model dropdowns.
 *      This spec does NOT assert a successful run completion (it would consume
 *      real LLM tokens and may not finish inside a CI-shaped timeout); it
 *      asserts the Agent-slug validation error, then accepts either a runId
 *      status chip or a graceful error alert on a Model-target submit, and
 *      only asserts the UI never crashes either way.
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

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "evals-write-path",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("evals — write path", () => {
  test("creates a dataset, opens its detail page, adds an item, and renders the run launcher", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ── 1. Fresh user + org (owner of the default workspace) ────────────────
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "evals-write",
    });

    // ── 2. Navigate to the workspace Evals page — fresh workspace, empty ────
    await gotoStable(page, `/${orgSlug}/default/evals`);
    await expect(
      page.getByRole("heading", { name: "Evals", exact: true }),
    ).toBeVisible({
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

    // ── 3. New dataset → Dialog → Manual mode → create ──────────────────────
    await page.getByTestId("evals-new-dataset").click();
    await expect(
      page.getByRole("heading", { name: "New dataset" }),
    ).toBeVisible({
      timeout: 10_000,
    });

    await page.getByLabel("Name").fill("Smoke dataset");
    await page.getByTestId("evals-create-manual-submit").click();

    // The dialog closes and the dataset card appears once the RSC list
    // re-fetches (router.refresh() inside the form's submit handler).
    const datasetCard = page.getByTestId("dataset-card-smoke-dataset");
    await expect(datasetCard).toBeVisible({ timeout: 20_000 });
    await expect(datasetCard).toContainText(/0 item/);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-dataset-created.png"),
      fullPage: true,
    });

    // ── 4. Click the card → navigate to the dataset detail PAGE (no drawer) ──
    await datasetCard.click();
    await page.waitForURL(/\/evals\/datasets\//, { timeout: 20_000 });
    const detail = page.getByTestId("evals-dataset-detail");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Smoke dataset" }),
    ).toBeVisible();
    // Runs table + stat row render (empty dataset → empty states, no crash).
    await expect(page.getByTestId("evals-runs-table")).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-dataset-detail.png"),
      fullPage: true,
    });

    // ── 5. Items tab → Add item ──────────────────────────────────────────────
    await page.getByTestId("evals-tab-items").click();
    const itemsPanel = page.getByTestId("evals-dataset-items");
    await expect(itemsPanel).toBeVisible({ timeout: 10_000 });

    await itemsPanel.getByLabel("Input").fill("What is 2+2?");
    await itemsPanel.getByLabel("Expected output (optional)").fill("4");
    await page.getByTestId("evals-add-item-submit").click();

    await expect(page.getByTestId("evals-dataset-item").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(itemsPanel.getByText("Items (1)")).toBeVisible({
      timeout: 20_000,
    });
    await expect(itemsPanel.getByText("What is 2+2?")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-item-added.png"),
      fullPage: true,
    });

    // ── 6. Run setup tab → run launcher renders + validates ──────────────────
    await page.getByTestId("evals-tab-setup").click();
    const runSetup = page.getByTestId("evals-run-setup");
    await expect(runSetup).toBeVisible({ timeout: 10_000 });
    await expect(
      runSetup.getByRole("heading", { name: "Run eval" }),
    ).toBeVisible();

    const runButton = page.getByTestId("evals-run-start");
    await expect(runButton).toBeVisible();

    // Agent target requires an agent slug — submitting without one shows an
    // inline validation error and must not crash the page. The segmented
    // control (Base UI ToggleGroup) renders plain buttons — scope to the
    // run-setup panel to avoid ambiguity.
    await runSetup.getByRole("button", { name: "Agent", exact: true }).click();
    await runButton.click();
    await expect(page.getByText(/agent slug is required/i)).toBeVisible({
      timeout: 10_000,
    });

    // Switch back to the Model target (the provider/model picker defaults to
    // "Default tier", which is a valid optional model) and submit. This DOES
    // call eval.run.start for real — accept either a runId status chip or a
    // graceful error alert (e.g. insufficient balance); either way the page
    // must not crash.
    await runSetup.getByRole("button", { name: "Model", exact: true }).click();
    await runButton.click();

    const runStatus = page.getByTestId("evals-run-status");
    const errorAlert = runSetup.getByRole("alert").last();
    await expect(runStatus.or(errorAlert)).toBeVisible({ timeout: 30_000 });

    // The detail page is still mounted (no crash on either run outcome).
    await expect(detail).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-run-setup.png"),
      fullPage: true,
    });
  });
});
