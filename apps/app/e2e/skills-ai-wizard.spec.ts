/**
 * skills-ai-wizard.spec.ts
 *
 * E2E for the AI-assisted skill setup wizard (Workbench → Skills → New skill).
 * The wizard is a 3-step flow: (1) Describe — natural-language prompt that
 * `skill.draft` turns into a full configuration; (2) Review — the create form
 * prefilled and editable; (3) Save — read-only summary, then `skill.create`.
 *
 * This spec proves the wizard chrome and the deterministic manual path
 * end-to-end (skip AI → fill form → summary → save → land on the skill detail
 * page). The AI generate button's gating (disabled until the prompt is long
 * enough) is asserted without invoking the live LLM, so the spec stays
 * hermetic — the model-call half is covered by skill.draft handler unit tests.
 *
 * NOTE: needs the full local stack (`pnpm dev`: Postgres :5433 + app server),
 * same as the other signup-driven specs.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { gotoStable } from "./helpers/nav";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SCREENSHOTS_DIR = path.resolve(
  import.meta.dirname,
  "screenshots",
  "skills-ai-wizard",
);

// Recreate this spec's screenshot sub-directory on each run (CLAUDE.md convention).
test.beforeAll(async () => {
  await rm(SCREENSHOTS_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
});

test.describe("skills AI-assisted setup wizard", () => {
  test("describe step gates AI generation; manual path creates a skill", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ── 1. Fresh owner + org ─────────────────────────────────────────────────
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "skill-wiz" });

    // ── 2. Open Workbench → Skills and launch the wizard ───────────────────────
    await gotoStable(page, `/${orgSlug}/default/workbench/tools/skills`);
    await expect(page).not.toHaveURL(/\/login/);

    const newSkillBtn = page.getByTestId("new-skill-btn");
    await expect(newSkillBtn).toBeVisible({ timeout: 15_000 });
    await newSkillBtn.click();

    // ── 3. Step 1 (Describe): AI generate gated on prompt length ────────────
    const describeInput = page.getByTestId("skill-wizard-describe-input");
    const generateBtn = page.getByTestId("skill-wizard-generate-btn");
    await expect(describeInput).toBeVisible();
    await expect(generateBtn).toBeDisabled();

    await describeInput.fill("short"); // < 10 chars — still gated
    await expect(generateBtn).toBeDisabled();

    await describeInput.fill(
      "Teach the agent how to triage production incidents: check dashboards, page on-call, keep a timeline.",
    );
    await expect(generateBtn).toBeEnabled();
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "01-describe-step.png"),
    });

    // ── 4. Manual path: skip AI → Review form (blank) ────────────────────────
    await page.getByTestId("skill-wizard-skip-btn").click();
    const nameInput = page.getByTestId("new-skill-name-input");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue("");

    const slugValue = `incident-triage-${Date.now()}`;
    await nameInput.fill("Incident Triage");
    // Name → slug auto-derivation happens on the manual path.
    await expect(page.getByTestId("new-skill-slug-input")).toHaveValue(
      "incident-triage",
    );
    await page.getByTestId("new-skill-slug-input").fill(slugValue);
    await page
      .getByTestId("new-skill-description-input")
      .fill("How to triage production incidents calmly and completely.");
    await page
      .getByTestId("new-skill-body-textarea")
      .fill(
        "## When to use\n\nLoad when an incident is declared.\n\n1. Check dashboards.\n2. Page on-call.",
      );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-review-step.png"),
    });

    // ── 5. Continue → Step 3 (Save) summary reflects the form ───────────────
    await page.getByTestId("skill-wizard-continue-btn").click();
    await expect(page.getByTestId("skill-wizard-summary-name")).toHaveText(
      "Incident Triage",
    );
    await expect(page.getByTestId("skill-wizard-summary-slug")).toHaveText(
      slugValue,
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-save-step.png"),
    });

    // ── 6. Save → land on the new skill's detail page ────────────────────────
    await page.getByTestId("new-skill-submit-btn").click();
    await expect(page).toHaveURL(
      new RegExp(`/workbench/tools/skills/${slugValue}`),
      { timeout: 30_000 },
    );
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-skill-created.png"),
    });
  });

  test("back navigation returns from review to describe with prompt intact", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "skill-wiz-back",
    });

    await gotoStable(page, `/${orgSlug}/default/workbench/tools/skills`);
    await page.getByTestId("new-skill-btn").click();

    const promptText =
      "Teach the agent our code review checklist and when to apply it.";
    await page.getByTestId("skill-wizard-describe-input").fill(promptText);
    await page.getByTestId("skill-wizard-skip-btn").click();
    await expect(page.getByTestId("new-skill-name-input")).toBeVisible();

    await page.getByTestId("skill-wizard-back-btn").click();
    await expect(page.getByTestId("skill-wizard-describe-input")).toHaveValue(
      promptText,
    );
  });
});
