/**
 * memories-bulk-import.spec.ts — end-to-end coverage for the Knowledge →
 * Memories bulk-import affordance.
 *
 * The parse step calls the AI gateway and the commit step writes to Neo4j;
 * neither is guaranteed in CI, so this spec asserts the deterministic UI
 * structure: the "Bulk Import" button opens the import sheet with its drop
 * zone, default-anchor field, and a (correctly disabled) Parse button. The
 * parse → editable-grid → commit logic is exercised in the unit tests
 * (memories-bulk-import.test.tsx).
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
    path: path.join(SCREENSHOT_DIR, `memories-bulk-import-${name}.png`),
    fullPage: true,
  });
}

test.describe("memories bulk import — open and structure", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  test("Bulk Import opens the upload sheet with its controls", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "mem-bulk",
    });
    const ws = "default";

    await page.goto(`/${orgSlug}/${ws}/knowledge/memories`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // The Bulk Import button is in the header next to New Memory.
    const bulkBtn = page.getByRole("button", { name: /bulk import/i });
    await expect(bulkBtn).toBeVisible({ timeout: 15_000 });
    await shot(page, "01-memories-page");

    await bulkBtn.click();

    // The select stage renders: drop zone, default anchor, and Parse button.
    await expect(
      page.getByText("Drop markdown files here, or click to choose"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Default node ref")).toBeVisible();

    const parseBtn = page.getByRole("button", { name: /parse documents/i });
    await expect(parseBtn).toBeVisible();
    // No files selected yet → Parse is disabled.
    await expect(parseBtn).toBeDisabled();
    await shot(page, "02-import-sheet-open");

    // A markdown file selection enables Parse (verifies the file input wiring).
    const fileInput = page.getByLabel("Choose markdown documents");
    await fileInput.setInputFiles({
      name: "rules.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("- never push to main\n- always open a PR"),
    });
    await expect(page.getByText("rules.md")).toBeVisible({ timeout: 10_000 });
    await expect(parseBtn).toBeEnabled();
    await shot(page, "03-file-selected");
  });
});
