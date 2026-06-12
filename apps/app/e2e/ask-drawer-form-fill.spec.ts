/**
 * ask-drawer-form-fill — e2e spec for the conversational page-form-fill flow.
 *
 * Verifies the full client wiring built for the AskDrawer / wand panel form
 * fill: pageContext rides the POST /api/v1/chat/stream body, the scripted
 * `page_form_fill` tool events route through interceptFormFillEvents into
 * PageContext, the FillOverlay renders the proposal, and the per-field Accept
 * applies the value into the live page form (the apply-callback round-trip).
 *
 * Flow:
 *   1. signUpFreshUser → /{orgSlug}/default/settings/general (the
 *      WorkspaceGeneralForm registers formId "workspace-general" via
 *      useRegisterFillableForm — fields: name, slug, description).
 *   2. interceptAgentStream with scripted events: tool-call-start
 *      (capability "page_form_fill") → tool-call-end (completed, output
 *      carrying a fields array proposing a new description) → text summary.
 *   3. A second route handler (registered AFTER the mock, so it runs FIRST)
 *      captures the POST body and route.fallback()s to the mock — proving
 *      pageContext.fillableForm.formId === "workspace-general" is sent.
 *   4. Open the agent drawer via the floating wand button — the most direct
 *      affordance (a single aria-labeled button; the AskBar path requires an
 *      "ask"-classified query since fill-verbs route to the one-shot
 *      fillFormAction instead). Both surfaces share the identical
 *      ChatPageContext wiring through ChatShellClient.
 *   5. Send "fill in a better description" through the drawer composer.
 *   6. Assert the FillOverlay (role="status", aria-label "AI fill
 *      suggestions") shows the proposed value; close the drawer (its modal
 *      backdrop covers the overlay), accept the description suggestion, and
 *      assert the page's #ws-description textarea now holds the proposal.
 *
 * holdRefresh (default true) is fine here: the FillOverlay accept applies
 * values client-side via the registered apply() callback — no server action,
 * so the held RSC refresh never blocks anything we assert on. The hold also
 * only matches /ask|/chat routes, not /settings/general.
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

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

const PROPOSED_DESCRIPTION =
  "Primary workspace for the engineering team's day-to-day automation and research.";

// Scripted stream events matching the exact StreamEvent shapes
// interceptFormFillEvents expects: a page_form_fill tool-call-start keyed by
// toolCallId, then a completed tool-call-end whose output carries the
// FormFillOutput fields array (description changed, name/slug echoed).
function pageFormFillEvents(toolCallId: string): StreamEvent[] {
  // name/slug are echoed unchanged (changed: false) — the overlay renders only
  // changed fields, so their current values are irrelevant to the assertions.
  const currentName = "default";
  return [
    {
      type: "tool-call-start",
      messageId: "e2e-fill-msg-01",
      toolCallId,
      capability: "page_form_fill",
      inputPreview: { instruction: "fill in a better description" },
      riskLevel: "low",
    },
    {
      type: "tool-call-end",
      toolCallId,
      status: "completed",
      durationMs: 140,
      output: {
        fields: [
          { name: "name", current: currentName, proposed: currentName, changed: false },
          { name: "slug", current: "default", proposed: "default", changed: false },
          {
            name: "description",
            current: "",
            proposed: PROPOSED_DESCRIPTION,
            changed: true,
            reason: "The description was empty; proposed one based on the workspace purpose.",
          },
        ],
      },
    },
    {
      type: "text",
      messageId: "e2e-fill-msg-01",
      text: "I've proposed an updated description — review the suggestion panel. The change applies only after you accept it.",
    },
  ];
}

test.describe("ask-drawer.page-form-fill", () => {
  test.beforeEach(() => {
    // Fresh screenshot directory each run (suite convention).
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("agent fill proposal renders in FillOverlay and accept applies to the page form", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "form-fill" });

    // ── 1. Page with a registered fillable form ──────────────────────────────
    await page.goto(`/${orgSlug}/default/settings/general`);
    await expect(page).not.toHaveURL(/\/login/);

    // The form must be mounted (and therefore registered in PageContext)
    // before the drawer send, or pageContext.fillableForm would be absent.
    const descriptionInput = page.locator("#ws-description");
    await expect(descriptionInput).toBeVisible({ timeout: 15_000 });
    await expect(descriptionInput).toHaveValue("");

    const toolCallId = "tcl_fill_001";

    // ── 2. SSE mock (registered first → runs last) ───────────────────────────
    await interceptAgentStream(page, {
      events: pageFormFillEvents(toolCallId),
      delayMs: 50,
    });

    // ── 3. Request-body capture (registered second → runs FIRST, then falls
    //       back to the mock above). Proves pageContext rides the request. ────
    let capturedBody: {
      pageContext?: {
        route?: string;
        fillableForm?: { formId?: string; fields?: Array<{ name: string }> };
      } | null;
    } | null = null;
    await page.route("**/api/v1/chat/stream", async (route) => {
      capturedBody = route.request().postDataJSON() as typeof capturedBody;
      await route.fallback();
    });

    // ── 4. Open the agent drawer via the wand button ─────────────────────────
    await page.getByRole("button", { name: "Open AI agent" }).click();

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // ── 5. Send the fill instruction through the drawer composer ────────────
    await composer.fill("fill in a better description");
    await page.getByRole("button", { name: /send message/i }).click();

    // ── 6. pageContext assertion: the POST body carried the registered form ──
    await expect
      .poll(() => capturedBody?.pageContext?.fillableForm?.formId, { timeout: 15_000 })
      .toBe("workspace-general");
    const sentFields = capturedBody!.pageContext!.fillableForm!.fields!.map((f) => f.name);
    expect(sentFields).toEqual(["name", "slug", "description"]);
    expect(capturedBody!.pageContext!.route).toContain(`/${orgSlug}/default/settings/general`);

    // ── 7. FillOverlay appears with the proposal ─────────────────────────────
    const overlay = page.getByRole("status", { name: "AI fill suggestions" });
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(overlay).toContainText("1 suggestion");
    await expect(overlay).toContainText(PROPOSED_DESCRIPTION);

    // Close the drawer before interacting with the overlay: the Sheet's modal
    // backdrop (z-50, portaled after the overlay) covers the fixed FillOverlay
    // panel. The overlay state lives in PageContextProvider, so it survives.
    await page.locator("#wand-panel").getByRole("button", { name: "Close" }).click();
    await expect(page.getByPlaceholder(/send a message/i)).toBeHidden({ timeout: 10_000 });

    // Screenshot: overlay visible with the proposed value, drawer closed.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "form-fill-overlay-visible.png"),
    });

    // ── 8. Accept the per-field suggestion ───────────────────────────────────
    await page.getByRole("button", { name: "Accept suggestion for description" }).click();

    // The apply() callback round-trip: the page form's textarea now holds the
    // proposed value (client-side state update — no server action involved).
    await expect(descriptionInput).toHaveValue(PROPOSED_DESCRIPTION, { timeout: 10_000 });

    // Screenshot: proposal applied to the live form.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "form-fill-accepted.png"),
    });
  });
});
