/**
 * workbench-agent-ai-setup — e2e for the AI-assisted agent-creation flow.
 *
 * Covers the new "Describe" first step of the Agent Builder (create mode):
 *   1. The Describe step renders with a Generate button and a Skip escape hatch.
 *   2. "Skip — configure manually" advances to Identity untouched.
 *   3. Manual setup from that point (name → slug auto-fill → Save draft) lands
 *      the agent in the list as a Draft — the same create path the AI prefill
 *      reuses unchanged.
 *
 * The suggest action itself is a Next server action (POSTs to the page, not a
 * mockable /api route — the established interception pattern only covers
 * /api/v1/* SSE routes), so the AI-generated prefill is unit-tested in
 * suggestion-mapping.test.ts; here we prove the surrounding UI and the shared
 * create path end-to-end.
 *
 * The "Recommended connections" panel is driven by the same un-stubbable suggest
 * action (its `recommendations[]`), so it likewise can't be exercised through
 * this page flow — it's covered directly in recommended-connections.test.tsx
 * (name + reason + kind badge + Connect link), and the action passthrough in
 * actions.test.ts. What IS reachable without stubbing — the create-mode agent
 * key preview on Review — is asserted below.
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

test("Describe step: skip reaches Identity and manual setup saves a draft", async ({
  page,
}) => {
  const user = await signUpFreshUser(page, { orgPrefix: "e2e-agentai" });

  // ── 1. Open the builder in create mode ────────────────────────────────────
  await page.goto(`/${user.orgSlug}/default/workbench/agents/new`);

  // The AI-assisted Describe step is the first step in create mode.
  await expect(page.getByTestId("step-describe")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("agent-describe-generate")).toBeVisible();
  await expect(page.getByTestId("agent-describe-skip")).toBeVisible();

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-ai-describe-step.png"),
    fullPage: true,
  });

  // ── 2. Skip advances to Identity, untouched ───────────────────────────────
  await page.getByTestId("agent-describe-skip").click();
  await expect(page.getByTestId("step-identity")).toBeVisible();
  await expect(page.getByTestId("agent-name-input")).toHaveValue("");

  // ── 3. Manual setup → Save draft (the shared create path) ─────────────────
  // Agent slugs are capped at 18 chars (global agent key ≤32:
  // org_ns.workspace_ns.slug). Keep the prefix short so the base36 timestamp
  // suffix stays within the cap.
  const slug = `e2e-${Date.now().toString(36)}`;
  await page.getByTestId("agent-name-input").fill("E2E Manual Agent");
  // Slug auto-derives from the name; overwrite it with a unique value so the
  // assertion below targets exactly this run's row.
  await page.getByTestId("agent-slug-input").fill(slug);

  // Jump to Review via the step rail and save the draft.
  await page.getByTestId("builder-step-review").click();
  await expect(page.getByTestId("step-review")).toBeVisible();

  // Create-mode agent key preview: the org/workspace namespaces are assigned
  // server-side on save, so Review shows a plain slug-only preview.
  const keyPreview = page.getByTestId("agent-key-review");
  await expect(keyPreview).toBeVisible();
  await expect(keyPreview).toContainText(slug);
  await expect(keyPreview).toContainText(/assigned when the agent is saved/i);

  await page.getByTestId("agent-save-draft").click();

  await expect(page.getByText(/draft saved/i)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-ai-draft-saved.png"),
    fullPage: true,
  });

  // ── 4. The agent appears in the list as a Draft ───────────────────────────
  await page.goto(`/${user.orgSlug}/default/workbench/agents`);
  const row = page.getByTestId(`agent-row-${slug}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText(/draft/i)).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "agent-ai-list-draft.png"),
    fullPage: true,
  });
});
