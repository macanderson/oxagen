/**
 * settings-consolidation.spec.ts
 *
 * web-app-2.0 Phase 2 Workspace Settings consolidation:
 *   1. `settings/general` renders "General" and "Members" in-page sub-tabs
 *      (Base UI Tabs, `?tab=` URL-synced) — General shows the workspace
 *      identity form; Members shows the read-only workspace roster
 *      (previously the standalone `settings/members` route, now folded in).
 *   2. `settings/agent-defaults` renders four in-page sub-tabs — Models ·
 *      Budget · Prompts · Memory Policy (previously four standalone routes:
 *      settings/models, settings/budget, settings/prompts, settings/memory)
 *      — and each sub-tab's form actually renders when selected.
 *
 * See docs/web-app-2.0/workspace/settings/general/spec.md and
 * docs/web-app-2.0/workspace/settings/agent-defaults/spec.md.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs (see settings-mobile.spec.ts).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "settings-consolidation",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("settings/general — General + Members sub-tabs", () => {
  test("shows both sub-tabs; Members switches content and syncs ?tab= in the URL", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "settings-gen",
    });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    // Both sub-tabs are present; General is the default (bare URL, no ?tab=).
    const generalTab = page.getByRole("tab", { name: "General" });
    const membersTab = page.getByRole("tab", { name: "Members" });
    await expect(generalTab).toBeVisible();
    await expect(membersTab).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${ws}/settings/general$`));

    // General panel: the workspace identity form.
    await expect(page.getByLabel("Workspace name")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-general-tab.png"),
      fullPage: false,
    });

    // Switch to Members — content swaps, no full navigation/reload, URL gains ?tab=members.
    await membersTab.click();
    await expect(page).toHaveURL(
      new RegExp(`${ws}/settings/general\\?tab=members`),
    );
    await expect(
      page.getByRole("heading", { name: "Workspace members" }),
    ).toBeVisible();
    // The signed-up user is the workspace owner — their own row is present.
    await expect(page.getByText("(you)")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-members-tab.png"),
      fullPage: false,
    });

    // A direct load of the ?tab=members URL lands straight on the Members panel.
    await gotoStable(page, `${ws}/settings/general?tab=members`);
    await expect(
      page.getByRole("heading", { name: "Workspace members" }),
    ).toBeVisible();

    // Switching back to General clears the query param.
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page).toHaveURL(new RegExp(`${ws}/settings/general$`));
    await expect(page.getByLabel("Workspace name")).toBeVisible();
  });
});

test.describe("settings/agent-defaults — Models · Budget · Prompts · Memory Policy sub-tabs", () => {
  test("shows all four sub-tabs and each form renders when selected", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "settings-agdef",
    });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/settings/agent-defaults`);
    await expect(page).not.toHaveURL(/\/login/);

    const modelsTab = page.getByRole("tab", { name: "Models" });
    const budgetTab = page.getByRole("tab", { name: "Budget" });
    const promptsTab = page.getByRole("tab", { name: "Prompts" });
    const memoryTab = page.getByRole("tab", { name: "Memory Policy" });
    await expect(modelsTab).toBeVisible();
    await expect(budgetTab).toBeVisible();
    await expect(promptsTab).toBeVisible();
    await expect(memoryTab).toBeVisible();

    // Models is the default sub-tab (bare URL, no ?tab=) — model defaults form
    // + the previously-unwired "Your coding-agent preferences" section.
    await expect(page).toHaveURL(new RegExp(`${ws}/settings/agent-defaults$`));
    await expect(page.getByText("AI model defaults")).toBeVisible();
    await expect(page.getByText("Your coding-agent preferences")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-agent-defaults-models.png"),
      fullPage: false,
    });

    // Budget sub-tab.
    await budgetTab.click();
    await expect(page).toHaveURL(
      new RegExp(`${ws}/settings/agent-defaults\\?tab=budget`),
    );
    await expect(page.getByText("Workspace turn budget")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-agent-defaults-budget.png"),
      fullPage: false,
    });

    // Prompts sub-tab: read-only system prompt viewer + editable settings form.
    await promptsTab.click();
    await expect(page).toHaveURL(
      new RegExp(`${ws}/settings/agent-defaults\\?tab=prompts`),
    );
    await expect(
      page.getByText("Effective workspace system prompt"),
    ).toBeVisible();
    // The instructions editor is a CodeMirror (MarkdownCodeEditor): it exposes
    // the "Workspace instructions" accessible name on both its root <div>
    // (via the visible <Label htmlFor>) and its inner contenteditable
    // (via aria-label), so scope to the first to avoid strict-mode ambiguity.
    await expect(
      page.getByLabel("Workspace instructions").first(),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-agent-defaults-prompts.png"),
      fullPage: false,
    });

    // Memory Policy sub-tab.
    await memoryTab.click();
    await expect(page).toHaveURL(
      new RegExp(`${ws}/settings/agent-defaults\\?tab=memory`),
    );
    await expect(
      page.getByRole("heading", { name: "Memory Policy" }),
    ).toBeVisible();
    await expect(page.getByLabel("Observation half-life (days)")).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "06-agent-defaults-memory.png"),
      fullPage: false,
    });

    // Back to Models clears the query param.
    await modelsTab.click();
    await expect(page).toHaveURL(new RegExp(`${ws}/settings/agent-defaults$`));
    await expect(page.getByText("AI model defaults")).toBeVisible();
  });
});
