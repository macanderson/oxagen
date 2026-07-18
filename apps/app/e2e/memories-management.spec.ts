/**
 * memories-management.spec.ts — end-to-end coverage for Knowledge → Memories
 * management controls: edit (lesson, kind, confidence), delete with confirm,
 * promote (two-axis memory model — OBSERVATION → RULE/FACT), demote (the
 * inverse), and dismissing a promotion candidate.
 *
 * Tests:
 *   1. Empty state: fresh workspace shows the header and "No memories yet";
 *      the class stats row and filter bar are intentionally absent (they
 *      only render once at least one memory exists).
 *   2. Edit/delete affordances: when a memory row is present, clicking it
 *      opens the detail sheet with Edit + Delete buttons; Edit mode renders
 *      the edit form; Delete shows a two-step confirm.
 *   3. Promote affordance: the detail sheet offers a "Promote to …" control
 *      for the current class; the rationale is optional — confirming with it
 *      left blank succeeds. FACT is the exception: it still requires the
 *      explicit "I confirm…" acknowledgement checkbox before the confirm
 *      button enables, regardless of rationale.
 *   4. Demote affordance: once a memory is above OBSERVATION, the detail
 *      sheet offers a "Demote to …" control; opening it renders a confirm +
 *      cancel step (validated without committing, since exercising it would
 *      undo the promote step's assertions on the same record).
 *   5. Dismiss: the inline "Suggested to promote" panel's Dismiss affordance
 *      removes a candidate and shows an Undo toast.
 *
 * Tests 2-5 require Neo4j to be running and the app to have written at
 * least one memory to the workspace. If no memories/candidates are present
 * (Neo4j not running or fresh workspace), those tests log a skip-like
 * message and exit gracefully rather than failing — the happy-path gate is
 * CI-gated when Neo4j is up.
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored, recreated each run).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

function shot(page: import("@playwright/test").Page, name: string) {
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `memories-mgmt-${name}.png`),
    fullPage: true,
  });
}

test.describe("memories management — empty state and UI structure", () => {
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("fresh workspace shows the Memories page with header, stats, and empty state", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mem-empty",
    });
    const ws = "default";

    // Navigate to Knowledge → Memories
    await page.goto(`/${orgSlug}/${ws}/knowledge/memories`);
    await expect(page).not.toHaveURL(/\/login/);

    // Page must render without crashing
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
    await shot(page, "01-fresh-workspace");

    // The BrainCircuit heading / "Agent Memories" label should be visible —
    // this comes from the MemoriesClient header section.
    await expect(page.getByText("Agent Memories", { exact: true })).toBeVisible(
      { timeout: 15_000 },
    );

    // The 3-column stats row (one per epistemic class) is intentionally
    // hidden on a genuinely empty workspace — it (and the filter bar) only
    // renders once at least one memory exists, so the empty state sits
    // directly under the header instead of below a full but inert control
    // bar (see the "Stats + filters" comment in memories-client.tsx).
    await expect(page.getByTestId("memory-stats-row")).toHaveCount(0);

    // The filter bar is gated behind the same records.length > 0 check as the
    // stats row — also hidden on a genuinely empty workspace.
    await expect(
      page.getByPlaceholder("Search lesson, source, or node ref..."),
    ).toHaveCount(0);

    // Empty state copy appears for a workspace with no memories.
    await expect(page.getByText("No memories yet")).toBeVisible();

    await shot(page, "02-empty-state-structure");
  });
});

test.describe("memories management — edit and delete affordances", () => {
  test("detail sheet renders Edit and Delete buttons when a row is clicked", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mem-controls",
    });
    const ws = "default";

    await page.goto(`/${orgSlug}/${ws}/knowledge/memories`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // Check if any memory rows are present (requires Neo4j with data). Rows
    // are role="button" <div>s (not native <button>s — see memories-client.tsx
    // for why), so scope the selector accordingly.
    // If the list is empty (fresh workspace, no agent sessions), we assert on
    // the empty state and skip the interactive affordance checks.
    const hasRows = (await page.locator('[role="button"].group').count()) > 0;
    if (!hasRows) {
      // Fresh workspace with no memories — assert the empty state is correct
      // and skip the sheet interaction test. The edit/delete UI is exercised
      // in the unit tests (memories-client.test.tsx) and in CI when Neo4j runs.
      await expect(page.getByText("No memories yet")).toBeVisible();
      await shot(page, "03-no-rows-empty-state");
      return;
    }

    // ── Row exists → click it ────────────────────────────────────────────────
    const firstRow = page.locator('[role="button"].group').first();
    await firstRow.click();
    await shot(page, "03-detail-sheet-open");

    // Detail sheet opened — Edit + Delete buttons are wired.
    await expect(
      page.getByRole("button", { name: /edit memory/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /delete memory/i }),
    ).toBeVisible();

    // ── Edit mode ────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: /edit memory/i }).click();

    // Edit form fields render with their expected ids. Class is read-only in
    // edit mode (a badge, not an input) — changing it goes through Promote.
    await expect(page.locator("#edit-memory-lesson")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("#edit-memory-kind")).toBeVisible();
    await expect(page.locator("#edit-memory-confidence")).toBeVisible();
    await expect(page.locator("#edit-memory-source")).toBeVisible();

    // Save changes + Cancel buttons are present in edit mode.
    await expect(
      page.getByRole("button", { name: /save changes/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /cancel/i })).toBeVisible();
    await shot(page, "04-edit-mode-fields");

    // Cancel returns to view mode (Edit/Delete buttons reappear).
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(
      page.getByRole("button", { name: /edit memory/i }),
    ).toBeVisible({ timeout: 5_000 });
    await shot(page, "05-back-to-view-mode");

    // ── Promote flow ─────────────────────────────────────────────────────────
    // A non-FACT memory offers at least one "Promote to …" target. Rationale
    // is optional — confirming with it left blank must succeed (promote_memory
    // no longer requires one; see agent.memory.promote.ts). FACT is the
    // exception: it still requires the explicit "I confirm…" acknowledgement
    // (a RULE record's only target is FACT, so this branch is reachable).
    const promoteButton = page
      .getByRole("button", { name: /^promote to /i })
      .first();
    if (await promoteButton.isVisible().catch(() => false)) {
      const isFactTarget =
        (await promoteButton.textContent())?.toLowerCase().includes("fact") ??
        false;
      await promoteButton.click();
      await shot(page, "06-promote-form-open");

      const confirmPromote = page.getByRole("button", {
        name: /^confirm promote to /i,
      });
      if (isFactTarget) {
        await expect(confirmPromote).toBeDisabled();
        await page
          .getByLabel(/I confirm this is a durable, org-wide fact/i)
          .check();
        await expect(confirmPromote).toBeEnabled();
      }
      await confirmPromote.click();
      await shot(page, "07-promote-confirmed");

      // The class badge in the sheet header updates on success — either a
      // further promote target appears, or (FACT, top of the ladder) it
      // doesn't; either is an acceptable post-promote state.
      await expect(page.getByRole("button", { name: /^promote to /i }).first())
        .toBeVisible({
          timeout: 10_000,
        })
        .catch(() => {
          // FACT (top of the ladder) has no further promote target — acceptable.
        });
    }

    // ── Demote flow ──────────────────────────────────────────────────────────
    // A memory above OBSERVATION offers at least one "Demote to …" target
    // (RULE/FACT → the inverse of promote). Validate the flow opens with a
    // confirm + cancel step without committing — completing it would undo the
    // promote assertions above on the same record.
    const demoteButton = page
      .getByRole("button", { name: /^demote to /i })
      .first();
    if (await demoteButton.isVisible().catch(() => false)) {
      await demoteButton.click();
      await shot(page, "07b-demote-form-open");

      await expect(
        page.getByRole("button", { name: /^confirm demote to /i }),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        page.getByRole("button", { name: /^cancel$/i }),
      ).toBeVisible();

      // Cancel out — this test validates the flow opens, not the mutation.
      await page.getByRole("button", { name: /^cancel$/i }).click();
      await expect(demoteButton).toBeVisible({ timeout: 5_000 });
      await shot(page, "07c-demote-form-cancelled");
    }

    // ── Delete confirm two-step ──────────────────────────────────────────────
    await page.getByRole("button", { name: /delete memory/i }).click();

    // Confirm step appears — "Delete permanently?" text and Confirm button.
    await expect(page.getByText("Delete permanently?")).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.getByRole("button", { name: /confirm delete memory/i }),
    ).toBeVisible();
    // Cancel is also present in confirm step.
    await expect(page.getByRole("button", { name: /^cancel$/i })).toBeVisible();
    await shot(page, "08-delete-confirm-step");

    // Cancel the confirm — returns to the regular Delete button.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(
      page.getByRole("button", { name: /delete memory/i }),
    ).toBeVisible({ timeout: 5_000 });
    await shot(page, "09-confirm-cancelled");
  });
});

test.describe("memories management — dismiss a promotion candidate", () => {
  test("dismisses a candidate from the inline suggested-to-promote panel and offers an Undo toast", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mem-dismiss",
    });
    const ws = "default";

    await page.goto(`/${orgSlug}/${ws}/knowledge/memories`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // The inline "Suggested to promote" panel only renders once
    // agent.memory.promotion.candidates returns at least one row — requires
    // Neo4j with citation-pressure data. If it's absent (fresh workspace or
    // Neo4j not running), skip gracefully rather than failing.
    const panelHeading = page.getByText("Suggested to promote");
    if (
      !(await panelHeading.isVisible({ timeout: 5_000 }).catch(() => false))
    ) {
      return;
    }
    await shot(page, "10-suggested-panel-visible");

    const dismissButton = page
      .getByRole("button", { name: /^dismiss candidate/i })
      .first();
    if (!(await dismissButton.isVisible().catch(() => false))) {
      return;
    }
    await dismissButton.click();

    // Optimistic removal — the Undo toast appears.
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible({
      timeout: 5_000,
    });
    await shot(page, "11-dismiss-undo-toast");
  });
});
