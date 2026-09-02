/**
 * workspace-settings-general.spec.ts
 *
 * OXA-1465 — Money-path E2E for the Workspace → Settings → General save, which
 * now routes through the `workspace.settings.write` kernel capability (no more
 * direct-to-DB write). The persist-across-reload proof: after Save, the saved
 * description must survive a full page reload (resolveWorkspace reads it back
 * out of the workspaces.settings JSONB — the same `settings.description` key
 * the write handler targets).
 *
 * Flow:
 *   1. Sign up a fresh user + org (real /signup form). The signup user is the
 *      org/workspace OWNER, so the IAM gate (owner/admin only) lets them save.
 *   2. Navigate to /{orgSlug}/default/settings/general.
 *   3. Fill the workspace name + a unique description.
 *   4. Save → assert the "Saved at …" success indicator appears.
 *   5. RELOAD the page.
 *   6. Assert the description textarea STILL shows the saved value (persisted).
 *
 * Screenshots of the saved and reloaded states are written to a dedicated
 * sub-directory under e2e/screenshots/, recreated on each run (CLAUDE.md
 * convention) so this spec never races the shared screenshots dir under
 * fullyParallel.
 *
 * NOTE: this spec needs the full local datastore stack (Postgres :5433 et al.
 * via `pnpm dev`) and the app dev server. It was authored against the real UI
 * but is NOT expected to run in a bare CI/agent shell without that stack.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "workspace-settings-general",
);

// Recreate this spec's screenshot sub-directory on each run (CLAUDE.md convention).
test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("workspace settings general — save + persist across reload", () => {
  test("fill name + description → Save → reload → description persists", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // ── 1. Fresh user + org (owner of the default workspace) ────────────────
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "ws-settings",
    });

    // ── 2. Navigate to the workspace General settings page ──────────────────
    await page.goto(`/${orgSlug}/default/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    const nameInput = page.locator("#ws-name");
    const descriptionInput = page.locator("#ws-description");
    await expect(nameInput).toBeVisible({ timeout: 15_000 });
    await expect(descriptionInput).toBeVisible();

    // ── 3. Fill the name + a unique, reload-detectable description ───────────
    const description = `E2E persisted description ${Date.now()}`;
    await nameInput.fill("Default Renamed");
    await descriptionInput.fill(description);

    // ── 4. Save → assert the success indicator ("Saved at …") appears ───────
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.getByText(/saved at/i)).toBeVisible({ timeout: 15_000 });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-saved.png"),
      fullPage: true,
    });

    // ── 5. RELOAD — the persistence proof ───────────────────────────────────
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);

    // ── 6. The saved description must survive the reload ────────────────────
    const reloadedDescription = page.locator("#ws-description");
    await expect(reloadedDescription).toBeVisible({ timeout: 15_000 });
    await expect(reloadedDescription).toHaveValue(description);
    // The renamed workspace name must also have persisted.
    await expect(page.locator("#ws-name")).toHaveValue("Default Renamed");

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-reloaded-persisted.png"),
      fullPage: true,
    });
  });
});
