/**
 * automations.spec.ts
 *
 * E2E for the Automations list + editor
 * (`/{orgSlug}/{workspaceSlug}/automations` and `.../automations/[automationId]`):
 *   1. The list renders under the Automations · Workflows · Lineage tab strip
 *      and a fresh workspace shows the "No automations yet" empty state (not an
 *      error or blank page), with the "New automation" CTA.
 *   2. Creating an automation via the New-automation dialog lands on the editor
 *      (the create flow routes to the new automation's detail page), where the
 *      trigger-config panel, read-only playbook, and "Never fired" run history
 *      render — the editor read path over automation.get.
 *   3. The human activation gate: toggling the enabled switch opens the confirm
 *      dialog, and confirming flips the automation live (Disabled → Enabled).
 *
 * NOTE: needs the full local stack (prod build + real backend), same as the
 * other signup-driven specs.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "automations",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("Automations list + editor", () => {
  test("renders under the tab strip with the empty state + New CTA", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "automations-empty",
    });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/automations`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(/\/automations$/);

    // Tab strip: Automations · Workflows · Lineage. automations-header.tsx
    // builds it from those three; the Triggers board this listed is gone.
    for (const label of ["Automations", "Workflows", "Lineage"]) {
      await expect(
        page
          .getByRole("tab", { name: label })
          .or(page.getByRole("link", { name: label }))
          .first(),
      ).toBeVisible({ timeout: 20_000 });
    }

    await expect(page.getByText("No automations yet")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("new-automation")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-automations-empty.png"),
      fullPage: true,
    });
  });

  test("create an automation → editor read path → human-gated enable", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "automations-create",
    });
    const ws = `/${orgSlug}/default`;

    await gotoStable(page, `${ws}/automations`);
    await expect(page.getByTestId("new-automation")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("new-automation").click();

    // Default trigger type is "event" — fill the name + entity type and create.
    const name = `E2E Deal watcher ${Date.now().toString(36)}`;
    await page.getByTestId("automation-name").fill(name);
    await page.getByTestId("entity-type").fill("Deal");
    await page.getByTestId("create-automation").click();

    // The create flow routes to the new automation's editor.
    await expect(page).toHaveURL(/\/automations\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name })).toBeVisible({
      timeout: 20_000,
    });

    // Editor read path: trigger config + read-only playbook + run history.
    // Match the section headings by role — "Playbook" also appears in body copy
    // (description, hints), so getByText would be a strict-mode violation.
    await expect(
      page.getByRole("heading", { name: "Trigger configuration" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Playbook" })).toBeVisible();
    await expect(page.getByText(/Never fired/)).toBeVisible();

    // Starts disabled (human-gated activation). "Disabled" appears in the status
    // badge and in body copy, so scope to the first match.
    await expect(page.getByText("Disabled").first()).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-automation-editor.png"),
      fullPage: true,
    });

    // ── Human activation gate ────────────────────────────────────────────────
    await page.getByTestId("enabled-switch").click();
    // The confirm dialog is the gate — enabling must cross it.
    await expect(page.getByText("Enable this automation?")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("confirm-enable").click();

    // After confirming, the automation flips live. "Enabled" also appears in
    // body copy, so scope to the first match.
    await expect(page.getByText("Enabled").first()).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-automation-enabled.png"),
      fullPage: true,
    });
  });
});
