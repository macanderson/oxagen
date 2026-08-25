/**
 * eval-datasets — e2e spec for Workspace → Evals.
 *
 * Signs up a fresh user (owner of a new org + default workspace) and
 * navigates to /{org}/{workspace}/evals. A fresh workspace has zero eval
 * datasets, so this asserts the page shell (header + copy + the datasets
 * section, whichever of the table or empty state renders) rather than
 * specific rows — the eval.dataset.create / eval.dataset.from_traces flows
 * that would populate data aren't wired to this UI yet.
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

const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots", "eval-datasets");

// Recreate this spec's screenshot sub-directory on each run (CLAUDE.md convention).
test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("evals — datasets page", () => {
  test("renders the Evals page shell for a fresh workspace", async ({ page }) => {
    test.setTimeout(90_000);

    // ── 1. Fresh user + org (owner of the default workspace) ────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "evals" });

    // ── 2. Navigate to the workspace Evals page ──────────────────────────────
    await page.goto(`/${orgSlug}/default/evals`);
    await expect(page).not.toHaveURL(/\/login/);

    // ── 3. Header renders with the wedge-aligned copy ────────────────────────
    await expect(page.getByRole("heading", { name: "Evals", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The header copy was rewritten (evals/page.tsx's PageHeader description);
    // "score what actually ran and got billed" survives only as a comment in
    // lib/routes.ts and is on no page.
    await expect(
      page.getByText(/graded by an LLM judge, every call metered/i),
    ).toBeVisible();

    // ── 4. The datasets section resolves to either the grid or the empty
    //        state — a fresh workspace has zero datasets, so assert whichever
    //        actually rendered rather than a specific one. The populated half
    //        is a card grid now (`evals-datasets-grid`), not a table; the
    //        `evals-datasets-table` this spec waited on is on no page. ───────
    const grid = page.getByTestId("evals-datasets-grid");
    const emptyState = page.getByTestId("evals-datasets-empty-state");
    await expect(grid.or(emptyState)).toBeVisible({ timeout: 15_000 });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-evals-page.png"),
      fullPage: true,
    });
  });
});
