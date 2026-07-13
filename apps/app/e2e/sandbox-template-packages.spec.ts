/**
 * sandbox-template-packages.spec.ts
 *
 * Money-path E2E for the sandbox-template **Packages** editor (the manager +
 * chip-input section). Proves the field survives the full round-trip through
 * the real create/update capabilities and the Postgres `packages` column:
 *
 *   1. Sign up a fresh owner + org (passes the Owner/Admin IAM gate the server
 *      actions re-check — apps/app does not bootstrap IAM).
 *   2. Create an environment, then on workbench/sandboxes open the template
 *      editor and add a Packages row: pick a manager (pip) and chip two specs,
 *      one carrying a version pin (`pydantic==2.5`). Save (create_sandbox_template).
 *   3. Reopen the saved template for edit and assert the manager + both chips
 *      were rehydrated from the stored template — the DB round-trip proof.
 *
 * Screenshots of the key states land under e2e/screenshots/, recreated per run
 * (CLAUDE.md convention).
 *
 * NOTE: needs the full local datastore stack (Postgres :5433 via `pnpm dev`),
 * the app dev server, and seeded IAM grants (`pnpm db:seed-iam`, idempotent).
 * Authored against the real UI; not expected to run in a bare CI/agent shell
 * without that stack.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "sandbox-template-packages",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("sandbox template — Packages editor round-trip", () => {
  test("chips packages on create and rehydrates them on edit", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // ── 1. Fresh owner + org ────────────────────────────────────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "sbx-pkg" });

    // ── 2. Create an environment ────────────────────────────────────────────
    await page.goto(`/${orgSlug}/default/workbench/environments`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByRole("button", { name: /new environment/i }).click();
    await page.locator("#env-name").fill("Production");
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(
      page.getByText("Production", { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });

    await page.goto(`/${orgSlug}/default/workbench/sandboxes`);
    await expect(page.getByTestId("sandbox-env-group-production")).toBeVisible({
      timeout: 20_000,
    });

    // ── 3. Create a template with a Packages row ────────────────────────────
    await page.getByTestId("sandbox-template-new-btn-production").click();
    await page.getByTestId("sandbox-template-name-input").fill("Pkg Runner");

    // Add a manager row, choose pip, and chip two specs (one version-pinned).
    await page.getByTestId("sandbox-template-add-package").click();
    await page
      .getByTestId("sandbox-template-package-manager-0")
      .selectOption("pip");

    const pkgInput = page.getByTestId("sandbox-template-package-input-0");
    await pkgInput.fill("fastapi");
    await pkgInput.press("Enter");
    await pkgInput.fill("pydantic==2.5");
    await pkgInput.press("Enter");

    await expect(page.getByText("fastapi", { exact: true })).toBeVisible();
    await expect(
      page.getByText("pydantic==2.5", { exact: true }),
    ).toBeVisible();

    // The Manifest preview reflects the 2 packages before we ever save.
    // Assert on the manifest JSON element itself — a bare getByText("packages")
    // is a strict-mode violation (the page's description copy also says
    // "packages"), and checking the JSON key is the actual intent anyway.
    await page.getByTestId("sandbox-template-manifest-tab").click();
    await expect(page.getByTestId("manifest-preview-json")).toContainText(
      '"packages"',
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-packages-configured.png"),
      fullPage: true,
    });

    await page.getByTestId("sandbox-template-save-btn").click();
    await expect(
      page.getByTestId("sandbox-template-row-pkg-runner"),
    ).toBeVisible({ timeout: 20_000 });

    // ── 4. Reopen for edit — the packages rehydrate from the DB ─────────────
    await page.getByTestId("sandbox-template-edit-pkg-runner").click();
    await expect(
      page.getByTestId("sandbox-template-package-manager-0"),
    ).toHaveValue("pip", { timeout: 20_000 });
    await expect(page.getByText("fastapi", { exact: true })).toBeVisible();
    await expect(
      page.getByText("pydantic==2.5", { exact: true }),
    ).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-packages-rehydrated.png"),
      fullPage: true,
    });
  });
});
