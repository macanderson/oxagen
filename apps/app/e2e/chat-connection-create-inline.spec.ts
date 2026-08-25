/**
 * chat.connection-create-inline — e2e spec.
 *
 * Signs up a fresh user, intercepts the /api/v1/chat/stream SSE endpoint with
 * a scripted "component" event that emits the connection-create-inline card,
 * and asserts:
 *  - the GitHub connect card renders inline in the chat
 *  - clicking "Connect GitHub" opens the GitHubConnectionWizard dialog
 *  - an UNKNOWN componentId renders the visible unavailable-component fallback
 *    instead of silently rendering nothing (the original bug)
 *
 * The wizard's connect→OAuth→repo-select flow is NOT asserted here — it talks
 * to the Hono API and GitHub and is covered by github-connect-start.spec.ts
 * and the wizard's own seams. This spec owns the chat-surface rendering.
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

// Scripted stream events: emit a component event for the given componentId,
// mirroring what translate-stream derives from an agent.ui.render tool result.
function connectionFormEvents(
  toolCallId: string,
  orgSlug: string,
  componentId: string,
): StreamEvent[] {
  return [
    {
      type: "tool-call-start",
      messageId: "e2e-conn-msg-01",
      toolCallId,
      capability: "render_agent_ui",
      inputPreview: { componentId },
      riskLevel: "low",
    },
    {
      type: "tool-call-end",
      toolCallId,
      status: "completed",
      output: {
        render: {
          componentId,
        },
      },
      durationMs: 50,
    },
    {
      type: "component",
      toolCallId,
      componentId,
      props: {
        connectorId: "github",
        // translate-stream injects these server-side in production.
        orgSlug,
        workspaceSlug: "default",
      },
    },
  ];
}

test.describe("chat.connection-create-inline", () => {
  test.beforeEach(() => {
    // Ensure fresh screenshot directory each run
    if (fs.existsSync(SCREENSHOT_DIR)) {
      fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("github connect card renders inline and launches the connection wizard", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "conn-inline" });

    // /sessions is the conversation route; /chat is a 301 shim onto it since
    // the Ask→Sessions rename (src/proxy.ts WS_RENAMES).
    await page.goto(`/${orgSlug}/default/sessions`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    const toolCallId = "tcl_conn_001";

    // Register the SSE mock BEFORE the user submits.
    await interceptAgentStream(page, {
      events: connectionFormEvents(toolCallId, orgSlug, "connection-create-inline"),
      delayMs: 50,
    });

    await composer.fill("connect github repo");

    const sendBtn = page.getByRole("button", { name: /send message/i });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // The inline GitHub connect card appears in the chat.
    const card = page.locator('[data-testid="connection-create-inline-github"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Connect a GitHub repository");

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "connection-create-inline-card.png"),
    });

    // Clicking the button opens the GitHubConnectionWizard dialog. A fresh
    // user has no GitHub App installation, so the wizard opens at the gate
    // step directing them to Workspace Settings (see #300).
    await card.locator('[data-testid="connection-create-inline-github-btn"]').click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText("Connect GitHub");
    await expect(dialog).toContainText(
      "The Oxagen GitHub App must be installed for this workspace.",
    );

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "connection-create-inline-wizard-open.png"),
    });
  });

  test("unknown componentId renders a visible unavailable-component fallback", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "conn-unknown" });

    await page.goto(`/${orgSlug}/default/sessions`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    // A componentId the registry does not know — the original silent-failure bug.
    await interceptAgentStream(page, {
      events: connectionFormEvents(
        "tcl_conn_002",
        orgSlug,
        "totally-made-up-component",
      ),
      delayMs: 50,
    });

    await composer.fill("connect something unsupported");

    const sendBtn = page.getByRole("button", { name: /send message/i });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // The fallback card is VISIBLE — not a silent empty gap.
    const fallback = page.locator('[data-testid="unknown-component-card"]');
    await expect(fallback).toBeVisible({ timeout: 15_000 });
    await expect(fallback).toContainText("isn't available in this view");
    await expect(fallback).toContainText("totally-made-up-component");

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "unknown-component-fallback.png"),
    });
  });
});
