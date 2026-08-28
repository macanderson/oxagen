/**
 * agent-rbac-builder — e2e for the Agent Builder's Agent RBAC surfaces
 * (Phase 5a, docs/specs/agent-rbac/spec.md §4 Phase 5).
 *
 * Proves, against the real stack, the four capability-ui-map bindings:
 *   1. Access step: the three system roles render with intent descriptions,
 *      "Agent Contributor" preselected (the backend's create default), and —
 *      on a non-enterprise org — the custom-roles tier hint.
 *   2. Selecting "Agent Operator" and saving the draft persists the role via
 *      assign_agent_role (+ revoke_agent_role of the auto-assigned default).
 *   3. Review step: the effective-scope accountability view renders all four
 *      dimensions (capabilities counts, graph mode/budget, MCP posture,
 *      skills/subagents) for the selected role.
 *   4. Agents list: the saved agent carries its role badge
 *      (list_agent_roles), and reopening the builder shows the persisted
 *      role as current.
 *
 * The delegation-ceiling disabled state can't be exercised here — a fresh
 * org is non-enterprise, where the ceiling is vacuously satisfied by design
 * (mirrors the handler's tier fast-path) — it is covered in
 * role-picker.test.tsx and the handler's own unit tests.
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

test("role picker: select Operator → review effective scope → save → list badge", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-rbac" });

  // ── 1. Open the builder and reach the Access step ─────────────────────────
  await page.goto(`/${user.orgSlug}/default/workbench/agents/new`);
  await expect(page.getByTestId("step-describe")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("agent-describe-skip").click();
  await expect(page.getByTestId("step-identity")).toBeVisible();

  // Agent slugs are capped (global agent key ≤32 chars) — keep it short.
  const slug = `rbac-${Date.now().toString(36)}`;
  await page.getByTestId("agent-name-input").fill("E2E RBAC Agent");
  await page.getByTestId("agent-slug-input").fill(slug);

  await page.getByTestId("builder-step-access").click();
  await expect(page.getByTestId("step-access")).toBeVisible();

  // The three system roles, with the backend's create default preselected.
  const observer = page.getByTestId("role-option-agent-observer");
  const contributor = page.getByTestId("role-option-agent-contributor");
  const operator = page.getByTestId("role-option-agent-operator");
  await expect(observer).toBeVisible();
  await expect(contributor).toBeVisible();
  await expect(operator).toBeVisible();
  await expect(contributor).toHaveAttribute("aria-checked", "true");

  // Intent descriptions render on the cards.
  await expect(observer).toContainText(/read\/answer only/i);
  await expect(operator).toContainText(/trusted automation/i);

  // Fresh orgs are non-enterprise: custom roles are tier-gated, said plainly.
  await expect(page.getByTestId("agent-role-custom-tier-hint")).toBeVisible();

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-rbac-access-step.png"),
    fullPage: true,
  });

  // ── 2. Select "Agent Operator" ────────────────────────────────────────────
  await operator.click();
  await expect(operator).toHaveAttribute("aria-checked", "true");
  await expect(contributor).toHaveAttribute("aria-checked", "false");

  // ── 3. Review: the effective-scope accountability view ────────────────────
  await page.getByTestId("builder-step-review").click();
  await expect(page.getByTestId("step-review")).toBeVisible();

  const panel = page.getByTestId("effective-scope-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("effective-scope-role")).toContainText(
    "Agent Operator",
  );
  // Graph: declared mode is the default "read" — Operator's extend ceiling
  // cannot widen it (intersection semantics, display-side).
  await expect(page.getByTestId("scope-graph-mode")).toContainText(/read/i);
  await expect(page.getByTestId("scope-graph-budget")).toContainText(
    /2 hops · 40 nodes/,
  );
  // Capabilities: the seeded Operator role carries real grant counts.
  await expect(page.getByTestId("scope-capabilities-counts")).toBeVisible();
  // MCP: Operator's posture is a single allow-all rule.
  await expect(page.getByTestId("scope-mcp")).toContainText(
    /all mcp tool calls allowed/i,
  );
  // Skills/subagents: nothing equipped — the real empty state renders, not hidden.
  await expect(page.getByTestId("scope-skills-list")).toContainText(
    /no skills equipped/i,
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-rbac-review-effective-scope.png"),
    fullPage: true,
  });

  // ── 4. Save the draft — persists the definition AND the role selection ────
  await page.getByTestId("agent-save-draft").click();
  await expect(page.getByText(/draft saved/i)).toBeVisible({
    timeout: 20_000,
  });
  // The role sync must not have failed (a failure raises its own toast).
  await expect(page.getByText(/role not applied/i)).not.toBeVisible();

  // ── 5. Agents list: the role badge renders per agent ──────────────────────
  await page.goto(`/${user.orgSlug}/default/workbench/agents`);
  const row = page.getByTestId(`agent-row-${slug}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByTestId(`agent-role-${slug}`)).toContainText(
    "Agent Operator",
  );

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-rbac-list-role-badge.png"),
    fullPage: true,
  });

  // ── 6. Reopen the builder: the persisted role is current + preselected ────
  //
  // Address the builder link by its test id. `getByRole("link").first()` took
  // whichever link the row rendered first, and the row renders three
  // (`agent-link-`, `agent-launch-`, `agent-edit-`), so the step depended on
  // DOM order that nothing in this spec pins.
  const builderLink = row.getByTestId(`agent-link-${slug}`);
  const builderHref = await builderLink.getAttribute("href");
  expect(builderHref).toBeTruthy();

  // Register the navigation wait BEFORE the click, and assert the navigation
  // itself rather than only the destination element. The old step asserted
  // `step-identity` straight after clicking, so a click that never navigated
  // was indistinguishable from a builder that rendered slowly: it failed 20
  // seconds later as a missing element, with the agents list still on screen
  // and nothing saying the navigation was what went wrong.
  await Promise.all([
    page.waitForURL(`**${builderHref}`, { timeout: 20_000 }),
    builderLink.click(),
  ]);

  // Edit mode has no Describe step — Identity is the first stage.
  await expect(page.getByTestId("step-identity")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("builder-step-access").click();
  await expect(page.getByTestId("step-access")).toBeVisible();
  await expect(
    page.getByTestId("role-option-agent-operator"),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByTestId("role-current-agent-operator"),
  ).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-rbac-edit-current-role.png"),
    fullPage: true,
  });
});
