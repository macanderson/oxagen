/**
 * chat.prompt-queue — e2e spec.
 *
 * Verifies the Claude-Code-style prompt queue UX in the chat composer:
 *  - submitting while a stream is in flight QUEUES the prompt (does not
 *    interrupt) and the queued prompt appears in an ordered list panel,
 *  - the queue panel exposes per-row reorder / edit / remove / send-now
 *    controls,
 *  - removing a queued item drops it from the list.
 *
 * The /api/v1/chat/stream SSE endpoint is mocked with a deliberately slow
 * single-event scenario so the streaming window is wide enough to queue a
 * second (and third) prompt before the turn finishes.
 *
 * Screenshots of the populated queue panel are written to the gitignored
 * e2e/screenshots/ directory.
 *
 * NOTE: requires the live app stack (signup + chat page). In sandboxes without
 * Docker/.env.local this is skipped by the absence of a running server; it is
 * written to run in CI and locally via `pnpm --filter @oxagen/app e2e`.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import type { StreamEvent } from "../src/components/chat/stream-event-types";

const SCREENSHOT_DIR = "e2e/screenshots";

function slowTextEvents(messageId: string): StreamEvent[] {
  return [{ type: "text", messageId, text: "Working on it…" }];
}

test.describe("chat.prompt-queue — queue management", () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("submitting mid-stream queues prompts in an ordered list with controls", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, {
      orgPrefix: "chat-queue",
    });

    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(composer).toBeEnabled();

    // Mock a SLOW stream so the streaming window stays open long enough to
    // queue follow-up prompts. holdRefresh keeps the live turn on screen.
    await interceptAgentStream(page, {
      events: slowTextEvents("e2e-queue-msg-01"),
      delayMs: 4_000,
      holdRefresh: false,
    });

    // Fire the first message — starts the (slow) stream.
    await composer.fill("First prompt that starts the stream");
    await page.getByRole("button", { name: /send message/i }).click();

    // Once streaming, the send button relabels to "Queue message". Wait for it.
    const queueBtn = page.getByRole("button", { name: /^queue message$/i });
    await expect(queueBtn).toBeVisible({ timeout: 8_000 });

    // Queue a second prompt.
    await composer.fill("Second prompt — should be queued");
    await queueBtn.click();

    // Queue a third prompt.
    await composer.fill("Third prompt — also queued");
    await queueBtn.click();

    // The queue panel must list both queued prompts in order.
    const queuePanel = page.getByRole("region", { name: /queued messages/i });
    await expect(queuePanel).toBeVisible();
    await expect(queuePanel).toContainText("Second prompt — should be queued");
    await expect(queuePanel).toContainText("Third prompt — also queued");
    await expect(queuePanel).toContainText("2 messages queued");

    // Per-row controls present (send-now / edit / move / remove).
    await expect(
      page.getByRole("button", { name: /send queued message 1 now/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /move queued message 2 up/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /remove queued message 1/i }),
    ).toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/prompt-queue-populated.png`,
      fullPage: true,
    });

    // Reorder: move the second queued item up → it becomes first.
    await page
      .getByRole("button", { name: /move queued message 2 up/i })
      .click();
    await expect(
      page.getByRole("button", {
        name: /edit queued message 1: third prompt/i,
      }),
    ).toBeVisible();

    // Remove the first queued item.
    await page
      .getByRole("button", { name: /remove queued message 1/i })
      .click();
    await expect(queuePanel).toContainText("1 message queued");
    await expect(queuePanel).not.toContainText("Third prompt — also queued");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/prompt-queue-after-remove.png`,
      fullPage: true,
    });
  });
});
