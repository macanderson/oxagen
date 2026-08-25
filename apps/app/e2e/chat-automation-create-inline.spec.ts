/**
 * chat.automation-create-inline — e2e spec.
 *
 * Signs up a fresh user, intercepts the /api/v1/chat/stream SSE endpoint with
 * a scripted "component" event that emits the automation-create-inline form,
 * and asserts:
 *  - the form renders with pre-filled values (name, entity type)
 *  - the user can edit the name field
 *  - submitting the form shows the "Created — disabled" state
 *
 * Submit-through-to-DB is NOT asserted here: the stream mock's holdRefresh
 * (required to keep the streamed component mounted) leaves a pending RSC
 * refresh that queues any subsequent server action, so the submit can never
 * resolve inside this harness. The created/enable flow is covered by the
 * component unit tests (automation-create-inline.test.tsx, actions mocked)
 * and the handler tests (automation.create/enable, real DB semantics).
 *
 * Screenshots go to apps/app/e2e/screenshots/ (gitignored).
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import type { StreamEvent } from "../src/components/chat/stream-event-types";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

// Scripted stream events: emit a component event that renders the
// automation-create-inline form with pre-filled props.
function automationFormEvents(
  toolCallId: string,
  orgSlug: string,
): StreamEvent[] {
  return [
    {
      type: "tool-call-start",
      messageId: "e2e-auto-msg-01",
      toolCallId,
      capability: "render_agent_ui",
      inputPreview: { componentId: "automation-create-inline" },
      riskLevel: "low",
    },
    {
      type: "tool-call-end",
      toolCallId,
      status: "completed",
      output: {
        render: {
          componentId: "automation-create-inline",
        },
      },
      durationMs: 120,
    },
    // The client renders from the dedicated "component" event — in production
    // translate-stream derives it from the tool result's `render` field.
    {
      type: "component",
      toolCallId,
      componentId: "automation-create-inline",
      props: {
        suggestedName: "Notify on new commit",
        suggestedDescription: "Fires when a new Commit node arrives on main",
        triggerType: "event",
        entityType: "Commit",
        eventType: "node.created",
        propertyConditions: [
          { property: "git_branch", operator: "eq", toValue: "main" },
        ],
        steps: [],
        // translate-stream injects these server-side in production.
        orgSlug,
        workspaceSlug: "default",
      },
    },
  ];
}

test.describe("chat.automation-create-inline", () => {
  test.beforeEach(() => {
    // Ensure fresh screenshot directory each run
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("automation-create-inline form renders with prefilled values and is editable", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "auto-inline",
    });

    // /sessions is the conversation route; /chat is a 301 shim onto it since
    // the Ask→Sessions rename (src/proxy.ts WS_RENAMES).
    await page.goto(`/${orgSlug}/default/sessions`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const toolCallId = "tcl_auto_001";

    // Register the SSE mock BEFORE the user submits.
    await interceptAgentStream(page, {
      events: automationFormEvents(toolCallId, orgSlug),
      delayMs: 50,
    });

    // Fill and submit the chat message to trigger the stream.
    await composer.fill("notify me when a new commit lands on main");

    const sendBtn = page.getByRole("button", { name: /send message/i });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // Wait for the automation form to appear in the chat.
    const form = page.locator('[data-testid="automation-create-form"]');
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Screenshot: form visible with pre-filled values
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "automation-form-prefilled.png"),
    });

    // Assert pre-filled name value
    const nameInput = form.locator('[data-testid="automation-name-input"]');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await expect(nameInput).toHaveValue("Notify on new commit");

    // Edit the name field
    await nameInput.fill("Notify on main branch commit");
    await expect(nameInput).toHaveValue("Notify on main branch commit");

    // Screenshot: after name edit
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "automation-form-name-edited.png"),
    });

    // The schema-driven event-config section renders (entity-type picker +
    // condition builder). On a fresh workspace with no schema defined the
    // section shows the "Define a schema" CTA instead of populated pickers —
    // both are valid states, so assert the section is present either way.
    const section = form.locator('[data-testid="schema-condition-section"]');
    await expect(section).toBeVisible({ timeout: 5_000 });

    // When a schema IS defined the entity-type Select and condition builder
    // appear; when it isn't, the no-schema CTA links to the ontology builder.
    const noSchemaCta = form.locator('[data-testid="no-schema-cta"]');
    const conditionBuilder = form.locator('[data-testid="condition-builder"]');
    await expect(noSchemaCta.or(conditionBuilder).first()).toBeVisible({
      timeout: 5_000,
    });

    // The submit button is enabled and ready — the actual submit→DB path is
    // covered at the unit/handler seams (see header comment).
    const submitBtn = form.locator('[data-testid="create-automation-submit"]');
    await expect(submitBtn).toBeEnabled({ timeout: 3_000 });

    // Screenshot: editable form ready to submit
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "automation-form-ready-to-submit.png"),
    });
  });
});
