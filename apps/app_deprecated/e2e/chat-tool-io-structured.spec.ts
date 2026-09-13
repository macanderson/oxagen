/**
 * chat.tool-io-structured — e2e spec + visual proof.
 *
 * Regression guard for the "tool calls render raw JSON" report. A
 * research.swarm.start tool call (and the approval card) used to dump their
 * input/output as `JSON.stringify` in a <pre>. They must now render as a typed
 * key/value tree: humanized labels, id chips, status pills — and NEVER raw JSON.
 */

import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import type { StreamEvent } from "../src/components/chat/stream-event-types";

const SWARM_INPUT = {
  depth: "deep",
  topic: "Captain William Anderson nuclear submarine career biography",
  maxParallel: 5,
  searchDepth: "basic",
  targetLabel: "Topic",
};
const SWARM_RESULT = {
  status: "running",
  swarmId: "fan_p48e66xt6jag15rqg0t10y",
  dispatchId: "fan_p48e66xt6jag15rqg0t10y",
  estimatedTasks: 15,
};

function events(messageId: string): StreamEvent[] {
  return [
    {
      type: "tool-call-start",
      messageId,
      toolCallId: "tcl_swarm",
      capability: "start_research_swarm",
      inputPreview: SWARM_INPUT,
      riskLevel: "low",
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_swarm",
      status: "completed",
      output: SWARM_RESULT,
      durationMs: 12_400,
    },
    // An approval card in the same turn (its proposed input must also render
    // structured). This pauses the stream, leaving both cards on screen.
    {
      type: "approval-required",
      approvalId: "apr_swarm",
      capability: "start_research_swarm",
      inputPreview: SWARM_INPUT,
      riskLevel: "high",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  ];
}

test.describe("chat.tool-io — tool calls render typed UI, never raw JSON", () => {
  test("research.swarm.start input/result render as labeled key/value, not JSON", async ({
    page,
  }) => {
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: "tool-io" });
    await page.goto(`/${orgSlug}/default/chat`);
    await expect(page).not.toHaveURL(/\/login/);

    const composer = page.getByPlaceholder(/send a message/i);
    await expect(composer).toBeVisible({ timeout: 10_000 });

    await interceptAgentStream(page, {
      events: events("e2e-tool-io-01"),
      delayMs: 50,
    });

    await composer.fill("Research Captain William Anderson");
    await page.getByRole("button", { name: /send message/i }).click();

    // Tool calls now render inside a collapsed ToolActivityGroup strip. Expand
    // the group, then the tool's row, to reveal its card. The card renders with
    // its header hidden (the row toggle is the disclosure), so the typed body is
    // visible immediately once the row is open — no separate expand step.
    const activityGroup = page.getByTestId("tool-activity-group");
    await expect(activityGroup).toBeVisible({ timeout: 12_000 });
    await activityGroup
      .getByRole("button", { name: /expand tool activity/i })
      .click();

    const activityRow = page.getByTestId("tool-activity-row-tcl_swarm");
    await expect(activityRow).toBeVisible({ timeout: 8_000 });
    await activityRow.getByRole("button").first().click();

    const toolCard = page.getByTestId("tool-call-card-tcl_swarm");
    await expect(toolCard).toBeVisible({ timeout: 8_000 });

    // Humanized labels — not raw camelCase JSON keys.
    await expect(toolCard.getByText("Search depth")).toBeVisible({
      timeout: 8_000,
    });
    await expect(toolCard.getByText("Max parallel")).toBeVisible();
    await expect(toolCard.getByText("Estimated tasks")).toBeVisible();
    // A status enum renders as a pill.
    await expect(toolCard.getByText("running")).toBeVisible();
    // The id renders as a copy chip (full id on the accessible name).
    await expect(
      toolCard
        .getByRole("button", { name: /fan_p48e66xt6jag15rqg0t10y/ })
        .first(),
    ).toBeVisible();

    // Hard guarantee: no raw JSON braces or quoted keys anywhere in the card.
    const cardText = (await toolCard.textContent()) ?? "";
    expect(cardText).not.toContain("{");
    expect(cardText).not.toContain('"status"');
    expect(cardText).not.toContain("swarmId");

    // The approval card's proposed input is structured too.
    const approvalCard = page
      .locator('[data-component="approval-card"]')
      .first();
    await expect(approvalCard).toBeVisible({ timeout: 8_000 });
    await expect(approvalCard.getByText("Proposed input")).toBeVisible();
    await expect(approvalCard.getByText("Search depth")).toBeVisible();
    expect((await approvalCard.textContent()) ?? "").not.toContain("{");

    await page.screenshot({
      path: "e2e/screenshots/chat-tool-io-structured.png",
      fullPage: true,
    });
    // Focused element shots so the full INPUT+RESULT tree (incl. id chips) and
    // the approval card are visible end-to-end.
    await toolCard.screenshot({
      path: "e2e/screenshots/chat-tool-io-tool-card.png",
    });
    await approvalCard.screenshot({
      path: "e2e/screenshots/chat-tool-io-approval-card.png",
    });
  });
});
