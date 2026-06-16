/**
 * agents.spec.ts — end-to-end coverage for the workspace Agents management UI.
 *
 * Drives the full lifecycle through the real UI against the running app + API +
 * Postgres stack:
 *   1. Sign up a fresh owner → navigate to /agents (empty state).
 *   2. Create an agent (name, instructions, a skill tool) → land on detail.
 *   3. See it listed on the agents list.
 *   4. Edit it (new version) and publish the version.
 *   5. Toggle deploy (activate).
 *   6. Add an event trigger (GitHub repo source change).
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

  test("create → list → edit → publish → deploy → add trigger", async ({ page }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "agents" });
    const ws = "default";

    // ── 1. Empty state ──────────────────────────────────────────────────────
    await page.goto(`/${orgSlug}/${ws}/agents`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /^Agents$/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/no agents yet/i)).toBeVisible();
    await shot(page, "01-empty");

    // ── 2. Create an agent ──────────────────────────────────────────────────
    await page.getByRole("link", { name: /create agent/i }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${ws}/agents/new`));
    await expect(page.getByRole("form", { name: /agent editor/i })).toBeVisible();

    await page.fill("#agent-name", "Repo Review Agent");
    await expect(page.locator("#agent-slug")).toHaveValue("repo-review-agent");
    await page.fill("#agent-description", "Reviews repository changes against the knowledge graph.");
    await page.fill("#agent-instructions", "You review repository changes and summarise risk.");

    // Add a skill tool.
    await page.getByRole("button", { name: /add tool/i }).click();
    await page.fill("#tool-ref-0", "coding");

    await shot(page, "02-create-form");

    await page.getByRole("button", { name: /create agent/i }).click();

    // Lands on the detail page for the new agent.
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/agents/repo-review-agent$`), {
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: /repo review agent/i })).toBeVisible();
    await expect(page.getByText(/skill: coding/i)).toBeVisible();
    await shot(page, "03-detail-after-create");

    // ── 3. See it listed ────────────────────────────────────────────────────
    await page.goto(`/${orgSlug}/${ws}/agents`);
    const row = page.getByRole("link", { name: /repo review agent/i });
    await expect(row).toBeVisible();
    await shot(page, "04-list-populated");

    // ── 4. Edit → publish ───────────────────────────────────────────────────
    await row.click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/agents/repo-review-agent$`));
    await page.getByRole("link", { name: /^Edit$/ }).click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/agents/repo-review-agent/edit$`));
    await page.fill(
      "#agent-instructions",
      "You review repository changes, summarise risk, and propose follow-ups.",
    );
    await page.getByRole("button", { name: /save new version/i }).click();
    await page.waitForURL(new RegExp(`/${orgSlug}/${ws}/agents/repo-review-agent$`), {
      timeout: 15_000,
    });

    // Publish the latest version → checksum appears.
    await page.getByRole("button", { name: /publish latest version/i }).click();
    await expect(page.getByText(/published checksum/i)).toBeVisible({ timeout: 15_000 });
    await shot(page, "05-published");

    // ── 5. Deploy (activate) ────────────────────────────────────────────────
    await page.getByRole("button", { name: /deploy \(activate\)/i }).click();
    // After activation the toggle flips to Deactivate.
    await expect(page.getByRole("button", { name: /deactivate/i })).toBeVisible({ timeout: 15_000 });
    await shot(page, "06-deployed");

    // ── 6. Add an event trigger (GitHub repo source change) ─────────────────
    await page.getByRole("button", { name: /add trigger/i }).click();
    await page.selectOption("#trigger-editor-type", "event");
    await page.fill("#trigger-editor-source", "github_repo");
    await page.fill("#trigger-editor-event", "push");
    await page.fill("#trigger-editor-branches", "main");
    await page.fill("#trigger-editor-paths", "src/**");
    await page.getByRole("button", { name: /save trigger/i }).click();

    await expect(page.getByText(/github_repo · push/i)).toBeVisible({ timeout: 15_000 });
    await shot(page, "07-trigger-added");
  });
});
