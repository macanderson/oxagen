/**
 * agents.spec.ts — end-to-end coverage for the workspace Agents management UI.
 *
 * Drives the full lifecycle through the real UI against the running app + API +
 * Postgres stack:
 *   1. Sign up a fresh owner → /agents lists the built-in, product-managed
 *      `qa-chat` agent (no empty state) and badges it "Managed".
 *   2. Open the managed agent → it is read-only: no Edit / Publish / Deploy
 *      controls, and a "Managed by Oxagen" callout explains why.
 *   3. Create a user agent (name, instructions, a skill tool) → land on detail.
 *   4. See it listed alongside the managed agent.
 *   5. Edit it (new version) and publish the version.
 *   6. Toggle deploy (activate).
 *   7. Add an event trigger (GitHub repo source change).
 *
 * Screenshots of key success states go to apps/app/e2e/screenshots/ (gitignored).
 * The directory is deleted + recreated at the start of the run.
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

function shot(page: import("@playwright/test").Page, name: string) {
  return page.screenshot({ path: path.join(SCREENSHOT_DIR, `agents-${name}.png`), fullPage: true });
}

test.describe("agents — management lifecycle", () => {
  test.beforeAll(() => {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("managed agent is read-only → create → list → edit → publish → deploy → add trigger", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "agents" });
    const ws = "default";

    // ── 1. The built-in managed agent is listed (no empty state) ────────────
    // Every fresh workspace is bootstrapped with the product-managed `qa-chat`
    // interactive agent, so the list is never empty and the agent is badged
    // "Managed".
    await page.goto(`/${orgSlug}/${ws}/automation/agents`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /^Automation$/ })).toBeVisible({ timeout: 15_000 });
    const managedRow = page.getByRole("link", { name: /qa chat agent/i });
    await expect(managedRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Managed", { exact: true }).first()).toBeVisible();
    await shot(page, "01-list-with-managed-agent");

    // ── 2. The managed agent is read-only ───────────────────────────────────
    await managedRow.click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/automation/agents/qa-chat$`), {
      timeout: 15_000,
    });
    await expect(page.getByText(/managed by oxagen/i)).toBeVisible();
    // No mutation affordances are rendered for a managed agent.
    await expect(page.getByRole("link", { name: /^Edit$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /publish latest version/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /deploy \(activate\)/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^deactivate$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add trigger/i })).toHaveCount(0);
    await shot(page, "02-managed-readonly");

    // ── 3. Create a user agent ──────────────────────────────────────────────
    await page.goto(`/${orgSlug}/${ws}/automation/agents`);
    await page.getByRole("link", { name: /new agent/i }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${ws}/automation/agents/new`));
    await expect(page.getByRole("form", { name: /agent editor/i })).toBeVisible();

    await page.fill("#agent-name", "Repo Review Agent");
    await expect(page.locator("#agent-slug")).toHaveValue("repo-review-agent");
    await page.fill("#agent-description", "Reviews repository changes against the knowledge graph.");
    await page.fill("#agent-instructions", "You review repository changes and summarise risk.");

    // Add a skill tool.
    await page.getByRole("button", { name: /add tool/i }).click();
    await page.fill("#tool-ref-0", "coding");

    await shot(page, "03-create-form");

    await page.getByRole("button", { name: /create agent/i }).click();

    // Lands on the detail page for the new agent.
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/automation/agents/repo-review-agent$`), {
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: /repo review agent/i })).toBeVisible();
    await expect(page.getByText(/skill: coding/i)).toBeVisible();
    await shot(page, "04-detail-after-create");

    // ── 4. See it listed ────────────────────────────────────────────────────
    await page.goto(`/${orgSlug}/${ws}/automation/agents`);
    const row = page.getByRole("link", { name: /repo review agent/i });
    await expect(row).toBeVisible();
    await shot(page, "05-list-populated");

    // ── 5. Edit → publish ───────────────────────────────────────────────────
    await row.click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/automation/agents/repo-review-agent$`));
    await page.getByRole("link", { name: /^Edit$/ }).click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/automation/agents/repo-review-agent/edit$`));
    await page.fill(
      "#agent-instructions",
      "You review repository changes, summarise risk, and propose follow-ups.",
    );
    await page.getByRole("button", { name: /save new version/i }).click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/automation/agents/repo-review-agent$`), {
      timeout: 15_000,
    });

    // Publish the latest version → checksum appears.
    await page.getByRole("button", { name: /publish latest version/i }).click();
    await expect(page.getByText(/published checksum/i)).toBeVisible({ timeout: 15_000 });
    await shot(page, "06-published");

    // ── 6. Deploy (activate) ────────────────────────────────────────────────
    await page.getByRole("button", { name: /deploy \(activate\)/i }).click();
    // After activation the toggle flips to Deactivate.
    await expect(page.getByRole("button", { name: /deactivate/i })).toBeVisible({ timeout: 15_000 });
    await shot(page, "07-deployed");

    // ── 7. Add an event trigger (GitHub repo source change) ─────────────────
    await page.getByRole("button", { name: /add trigger/i }).click();
    await page.selectOption("#trigger-editor-type", "event");
    await page.fill("#trigger-editor-source", "github_repo");
    await page.fill("#trigger-editor-event", "push");
    await page.fill("#trigger-editor-branches", "main");
    await page.fill("#trigger-editor-paths", "src/**");
    await page.getByRole("button", { name: /save trigger/i }).click();

    await expect(page.getByText(/github_repo · push/i)).toBeVisible({ timeout: 15_000 });
    await shot(page, "08-trigger-added");
  });
});
