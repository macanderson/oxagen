/**
 * knowledge-memory.spec.ts — end-to-end coverage for Knowledge → Memory
 * (web-app-2.0 Phase 2): the pre-existing memory list plus the three new
 * sections — Promotion Candidates queue, Memory Citations, and Attach
 * Evidence — each rendering independently as its own <Suspense> section.
 *
 * Tests:
 *   1. Fresh workspace: the main memories list, the Promotion Candidates
 *      queue (empty state), the Memory Citations panel (pre-search empty
 *      state), and the Attach Evidence form all render without crashing, and
 *      the page links out to the decay-policy editor in Agent Defaults
 *      instead of duplicating it.
 *   2. Memory Citations: entering a (non-existent) execution id and
 *      submitting surfaces either an empty-results or an error state — never
 *      a crash — proving the section fails open independently of the other
 *      sections on the page.
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
    path: path.join(SCREENSHOT_DIR, `knowledge-memory-${name}.png`),
    fullPage: true,
  });
}

test.describe("Knowledge → Memory — list + new sections render", () => {
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("fresh workspace renders the memory list, promotion queue, citations, and evidence sections", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mem-sections",
    });
    const ws = "default";

    await page.goto(`/${orgSlug}/${ws}/knowledge/memory`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
    await shot(page, "01-page-loaded");

    // ── Existing memory list (pre-existing, renamed from knowledge/memories) ──
    await expect(page.getByText("Agent Memories", { exact: true })).toBeVisible(
      { timeout: 15_000 },
    );

    // ── Promotion Candidates queue (new) ─────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "Promotion Candidates" }),
    ).toBeVisible({ timeout: 15_000 });
    // A fresh workspace has no citation pressure yet — empty state.
    await expect(page.getByText("No promotion candidates")).toBeVisible();
    await shot(page, "02-promotion-queue-empty");

    // ── Memory Citations panel (new) ─────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "Memory Citations" }),
    ).toBeVisible();
    await expect(page.getByLabel("Execution ID")).toBeVisible();
    await expect(page.getByText("No execution looked up yet")).toBeVisible();
    await shot(page, "03-citations-empty");

    // ── Attach Evidence form (new) ────────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: "Attach Evidence" }),
    ).toBeVisible();
    await expect(page.getByLabel("Memory ID")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /attach evidence/i }),
    ).toBeVisible();
    await shot(page, "04-evidence-attach-form");

    // ── Decay-policy cross-link — linked out to, not reimplemented ──────────
    const decayLink = page.getByRole("link", {
      name: /workspace settings.*agent defaults/i,
    });
    await expect(decayLink).toBeVisible();
    await expect(decayLink).toHaveAttribute(
      "href",
      `/${orgSlug}/${ws}/settings/agent-defaults`,
    );
  });

  test("Memory Citations panel fails open on a lookup for a non-existent execution", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mem-citations",
    });
    const ws = "default";

    await page.goto(`/${orgSlug}/${ws}/knowledge/memory`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    await page.getByLabel("Execution ID").fill("exec_does_not_exist");
    await page.getByRole("button", { name: /load citations/i }).click();

    // Either an empty-results state or a surfaced error is acceptable — the
    // hard requirement is that the section does not crash and the rest of
    // the page (the memory list) remains intact.
    await expect(
      page
        .getByText("No citations recorded")
        .or(page.getByText("Failed to load citations")),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, "05-citations-lookup-result");

    // The main list section is unaffected by the citations lookup.
    await expect(
      page.getByText("Agent Memories", { exact: true }),
    ).toBeVisible();
  });
});
