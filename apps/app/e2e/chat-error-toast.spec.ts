/**
 * chat.error-toast — e2e spec.
 *
 * Regression guard for the "raw JSON error rendered inline" bug. When the chat
 * stream surfaces a turn-level failure (a 402 billing block such as
 * insufficient_credits, a gateway error, or a server throw) the runtime now
 * emits a structured `error` StreamEvent instead of folding the API error
 * envelope into a `text` event. The client must surface it as a TOAST — never
 * render the raw `{"error":{"code":…,"message":…},"requestId":…}` envelope
 * inline in the message thread.
 *
 * This spec signs up a fresh user, intercepts the SSE endpoint with a single
 * `error` event, sends a message, and asserts:
 *  - a destructive toast appears with the friendly title + dedicated
 *    "out of usage credits" copy (not the raw server message) plus a
 *    clickable link straight to the org's credits-purchase page,
 *  - the raw error envelope (snake_case code, `requestId`, JSON braces) does
 *    NOT appear anywhere in the chat surface.
 *
 * The server-side envelope→{code,message} parsing is unit-tested in
 * stream-parts.test.ts / translate-stream.test.ts; this exercises the
 * client toast path end-to-end.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import type { StreamEvent } from "../src/components/chat/stream-event-types";

const HUMAN_MESSAGE =
  "Insufficient credits: your balance is empty. Please add credits to continue.";

// A single turn-level error event — exactly what the stream route now emits
// after parsing a 402 billing envelope into {code, message}.
function billingErrorEvents(messageId: string): StreamEvent[] {
  return [
    {
      type: "error",
      messageId,
      code: "insufficient_credits",
      message: HUMAN_MESSAGE,
    },
  ];
}

test.describe("chat.error-toast — turn error surfaces a toast, not inline JSON", () => {
  test("an insufficient_credits stream error shows a toast and never renders raw JSON inline", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "chat-err" });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(composer).toBeEnabled();

    // Register the SSE mock BEFORE submitting so the route is intercepted.
    await interceptAgentStream(page, {
      events: billingErrorEvents("e2e-msg-err-01"),
      delayMs: 50,
    });

    await composer.fill("Run an expensive agent task");
    const sendBtn = page.getByRole("button", { name: /send message/i });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // insufficient_credits gets dedicated copy (not the raw server message) plus
    // a clickable link straight to the credits-purchase page. (The Base UI toast
    // is portaled to the viewport at the document root.)
    await expect(page.getByText(/out of usage credits/i)).toBeVisible({
      timeout: 12_000,
    });
    // And the friendly, code-derived title.
    await expect(
      page.getByText("Insufficient credits", { exact: true }),
    ).toBeVisible({
      timeout: 5_000,
    });
    const purchaseLink = page.getByRole("link", { name: "here" });
    await expect(purchaseLink).toBeVisible();
    await expect(purchaseLink).toHaveAttribute(
      "href",
      `/${orgSlug}/billing/subscription`,
    );

    // The raw error envelope must NOT leak onto the page in any form: not the
    // snake_case machine code, not the requestId field, not JSON object braces.
    const body = page.locator("body");
    await expect(body).not.toContainText("insufficient_credits");
    await expect(body).not.toContainText("requestId");
    await expect(body).not.toContainText('{"error"');

    // Capture the success state (gitignored e2e/screenshots/).
    await page.screenshot({
      path: "e2e/screenshots/chat-error-toast.png",
      fullPage: true,
    });

    // The credits link's href is asserted above; verify its target is a real,
    // reachable purchase page (it doesn't dead-redirect back to /ask). We
    // navigate directly rather than click the toast link: the Next <Link> lives
    // inside the Base UI toast portal, where a Playwright synthetic click races
    // Next's router readiness and often no-ops within a run — a test-harness
    // artifact, not a user-facing issue (the href is a plain, correct anchor).
    await page.goto(`/${orgSlug}/billing/subscription`);
    await expect(page).toHaveURL(
      new RegExp(`/${orgSlug}/billing/subscription`),
    );
  });
});
