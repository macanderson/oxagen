/**
 * sandbox-templates.spec.ts
 *
 * Money-path E2E for the portable sandbox-templates feature (plan §7). Exercises
 * the full app surface for the sandbox.template.* + agent.environment.*
 * capability families end-to-end against the real UI:
 *
 *   1. Sign up a fresh user + org (the OWNER — passes the Owner/Admin IAM gate
 *      that the server actions re-check, since apps/app does not bootstrap IAM).
 *   2. workbench/environments: create an environment. Then on
 *      workbench/sandboxes: create a sandbox template (create_sandbox_template),
 *      a second one, and promote the second to the environment default
 *      (set_default_sandbox_template).
 *   3. Export the default template's manifest (export_sandbox_template) and
 *      capture the downloaded JSON.
 *   4. Import that manifest back into the same environment under a new slug
 *      (import_sandbox_template) — the round-trip proof.
 *   5. Create a draft agent, open it, and bind it to the environment
 *      (bind_agent_environment); assert the binding row renders.
 *
 * Screenshots of the key success states are written to a dedicated sub-dir
 * under e2e/screenshots/, recreated on each run (CLAUDE.md convention).
 *
 * NOTE: this spec needs the full local datastore stack (Postgres :5433 et al.
 * via `pnpm dev`) and the app dev server, AND the new capabilities' IAM grants
 * seeded locally (`pnpm db:seed-iam`, idempotent). It is authored against the
 * real UI but is NOT expected to run in a bare CI/agent shell without that
 * stack.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { rm, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "sandbox-templates",
);

test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("sandbox templates — create, set-default, export/import, bind agent", () => {
  test("full round-trip through workbench environments + sandboxes + agent bindings", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // ── 1. Fresh owner + org ────────────────────────────────────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "sbx-tpl" });

    // ── 2. Create an environment (Workbench → Environments) ─────────────────
    await page.goto(`/${orgSlug}/default/workbench/environments`);
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByRole("button", { name: /new environment/i }).click();
    await page.locator("#env-name").fill("Production");
    await page.getByRole("button", { name: /^create$/i }).click();
    // The new env chip renders once the page revalidates — wait before leaving.
    await expect(
      page.getByText("Production", { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Templates now live on Workbench → Sandboxes; the new env's template
    // group appears there once the page loads.
    await page.goto(`/${orgSlug}/default/workbench/sandboxes`);
    await expect(page.getByTestId("sandbox-templates-section")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("sandbox-env-group-production")).toBeVisible({
      timeout: 20_000,
    });

    // ── 3. Create the first sandbox template ────────────────────────────────
    await page.getByTestId("sandbox-template-new-btn-production").click();
    await page.getByTestId("sandbox-template-name-input").fill("Base Runner");
    await page.getByTestId("sandbox-template-save-btn").click();
    await expect(
      page.getByTestId("sandbox-template-row-base-runner"),
    ).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-template-created.png"),
      fullPage: true,
    });

    // ── 4. Create a second template + promote it to default ─────────────────
    await page.getByTestId("sandbox-template-new-btn-production").click();
    await page.getByTestId("sandbox-template-name-input").fill("SWE Runner");
    await page.getByTestId("sandbox-template-save-btn").click();
    await expect(
      page.getByTestId("sandbox-template-row-swe-runner"),
    ).toBeVisible({
      timeout: 20_000,
    });

    // Promote SWE Runner to the environment default (set_default_sandbox_template).
    const setDefaultBtn = page.getByTestId(
      "sandbox-template-setdefault-swe-runner",
    );
    if (await setDefaultBtn.count()) {
      await setDefaultBtn.click();
    }
    // After promotion the row shows a "★ default" promotion badge. The row
    // ALSO carries a static "provider default" spec chip, so target the
    // promotion badge by its EXACT full text "★ default": a bare "default"
    // substring matches both badges AND every ancestor that contains them
    // (strict-mode violation), while an exact "default" matches NEITHER (the
    // promotion badge text is "★ default", not "default"). Exact-matching the
    // whole badge text resolves to just the one leaf <Badge>.
    await expect(
      page
        .getByTestId("sandbox-template-row-swe-runner")
        .getByText("★ default", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-default-set.png"),
      fullPage: true,
    });

    // ── 5. Export the default template's manifest ───────────────────────────
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("sandbox-template-export-swe-runner").click();
    const download = await downloadPromise;
    const manifestPath = path.join(SCREENSHOTS_DIR, "exported-manifest.json");
    await download.saveAs(manifestPath);
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest.kind).toBe("oxagen.sandbox-template");
    expect(manifest.slug).toBe("swe-runner");

    // ── 6. Import the manifest back under a new slug (round-trip) ────────────
    await page.getByTestId("sandbox-template-import-btn").click();
    await page.getByTestId("sandbox-import-textarea").fill(manifestText);
    await page.getByRole("button", { name: /^preview$/i }).click();
    // Slug override input surfaces after a successful parse. Give it a unique slug.
    const importedSlug = "swe-runner-copy";
    await page.locator('input[placeholder="swe-runner"]').fill(importedSlug);
    await page.getByTestId("sandbox-import-confirm-btn").click();
    await expect(
      page.getByTestId(`sandbox-template-row-${importedSlug}`),
    ).toBeVisible({ timeout: 20_000 });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-import-round-trip.png"),
      fullPage: true,
    });

    // ── 7. Create a draft agent + bind it to the environment ────────────────
    await page.goto(`/${orgSlug}/default/workbench/agents/new`);
    await expect(page.getByTestId("step-describe")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("agent-describe-skip").click();
    await expect(page.getByTestId("step-identity")).toBeVisible();
    const agentSlug = `sbx-agent-${Date.now().toString(36)}`;
    await page.getByTestId("agent-name-input").fill("Sandbox Bind Agent");
    await page.getByTestId("agent-slug-input").fill(agentSlug);
    await page.getByTestId("builder-step-review").click();
    await page.getByTestId("agent-save-draft").click();
    await expect(page.getByText(/draft saved/i)).toBeVisible({
      timeout: 20_000,
    });

    // Open the agent's detail page (where the Environments card renders).
    await page.goto(`/${orgSlug}/default/workbench/agents`);
    // The row itself is not clickable — the name cell's link navigates to the
    // agent detail page. Address that link by its test id rather than by DOM
    // order: the row renders three (`agent-link-`, `agent-launch-`,
    // `agent-edit-`), so `.first()` rested on an order nothing here pins.
    const detailLink = page
      .getByTestId(`agent-row-${agentSlug}`)
      .getByTestId(`agent-link-${agentSlug}`);
    const detailHref = await detailLink.getAttribute("href");
    expect(detailHref).toBeTruthy();

    // Register the navigation wait before the click and assert the navigation
    // itself. Asserting only the destination card made a click that never
    // navigated look like a card that never rendered: the Playwright error
    // context for the failure this replaces shows the agents LIST still on
    // screen ("Agents", "All (2)") after 20 s of waiting for a card that only
    // exists on the detail page.
    await Promise.all([
      page.waitForURL(`**${detailHref}`, { timeout: 20_000 }),
      detailLink.click(),
    ]);

    await expect(page.getByTestId("agent-environments-card")).toBeVisible({
      timeout: 20_000,
    });

    // Bind the Production environment (bind_agent_environment). The option
    // label is "<name> (<slug>)" (+" ★" when default) — never the bare env
    // name — so resolve the option's value instead of matching an exact label.
    const bindSelect = page.getByTestId("agent-bind-env-select");
    const productionOption = bindSelect
      .locator("option", { hasText: "Production" })
      .first();
    await expect(productionOption).toBeAttached({ timeout: 20_000 });
    const productionValue = await productionOption.getAttribute("value");
    await bindSelect.selectOption(productionValue!);
    await page.getByTestId("agent-bind-submit").click();
    await expect(page.getByTestId("agent-binding-row-production")).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-agent-bound.png"),
      fullPage: true,
    });

    // ── 8. Unbind the environment (unbind_agent_environment) ─────────────────
    await page.getByTestId("agent-binding-unbind-production").click();
    // The binding row disappears; the card falls back to the empty state.
    await expect(page.getByTestId("agent-binding-row-production")).toHaveCount(
      0,
      { timeout: 20_000 },
    );

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-agent-unbound.png"),
      fullPage: true,
    });
  });
});
