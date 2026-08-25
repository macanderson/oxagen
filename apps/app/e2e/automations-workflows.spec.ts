/**
 * automations-workflows — e2e spec for the Workflows & swarms launch/monitor
 * page.
 *
 * Signs up a fresh user (a brand-new workspace has zero runs) and asserts:
 *  - the page renders through the real RSC → invoke → agent.execution.list
 *    path (workflow-run rows filtered client-side — see lib/automations/
 *    workflows.ts) and shows the empty state + Launch CTA;
 *  - the shared Automations tab strip (Automations / Triggers / Workflows) is
 *    present;
 *  - the launch dialog opens with the Workflow tab's goal field, and
 *    client-side validation blocks an empty-goal submit inline
 *    (data-testid="launch-error") without calling the capability;
 *  - the Swarm tab is reachable and shows its topic field.
 *
 * Does NOT launch a real workflow or swarm (would dispatch a live Inngest
 * fan-out / subagent swarm) — the dialog is closed via Cancel instead. The
 * launch → server-action → invoke() wiring is covered by
 * lib/automations/workflows.test.ts (mocked invoke) and actions.ts's
 * zod-bounds validation; the populated-list + detail-drawer path is out of
 * scope for a fresh-workspace e2e run (nothing to seed a workflow run with
 * here without actually dispatching one).
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { signUpFreshUser } from "./helpers/signup";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

test("workflows page renders, tab strip + Launch CTA present, empty state for a fresh workspace", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-wf" });

  await page.goto(`/${user.orgSlug}/default/automations/workflows`);

  // Shared Automations tab strip (ARIA tablist — see page-tabs.tsx).
  await expect(page.getByRole("tab", { name: "Workflows" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("tab", { name: "Automations" })).toBeVisible();
  // Lineage, not Triggers. automations-header.tsx builds the strip from
  // Automations / Workflows / Lineage, and the Triggers board this asserted
  // no longer exists anywhere under apps/app/src.
  await expect(page.getByRole("tab", { name: "Lineage" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Workflows" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Fresh workspace → combined empty state + Launch CTA (canManage=true for
  // the org Owner that signUpFreshUser creates).
  await expect(page.getByText("No workflows or swarms yet")).toBeVisible({
    timeout: 20_000,
  });
  const launchButton = page.getByTestId("launch-workflow");
  await expect(launchButton).toBeVisible();

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "automations-workflows-empty.png"),
    fullPage: true,
  });
});

test("launch dialog: Workflow tab client-validates an empty goal inline, Swarm tab reachable", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-wflaunch" });

  await page.goto(`/${user.orgSlug}/default/automations/workflows`);
  const launchButton = page.getByTestId("launch-workflow");
  await expect(launchButton).toBeVisible({ timeout: 20_000 });
  await launchButton.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("workflow-goal")).toBeVisible();

  // Submitting an empty goal shows the capability-bound inline error — never
  // a generic toast — and never calls run_workflow.
  await page.getByTestId("launch-submit").click();
  await expect(page.getByTestId("launch-error")).toHaveText("Goal is required.");

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "automations-workflows-launch-validation.png"),
    fullPage: true,
  });

  // Swarm tab is reachable and shows its own topic field.
  await page.getByTestId("launch-tab-swarm").click();
  await expect(page.getByTestId("swarm-topic")).toBeVisible();

  // Close without launching a real workflow or swarm.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
