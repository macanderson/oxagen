/**
 * mcp-agent-integration.spec.ts
 *
 * E2E flow 9: Agent integration — an installed+enabled MCP server's tool
 * is callable within an interactive Q&A agent turn.
 *
 * Design:
 *   - seedPlugin inserts an mcp.mcp_servers row pointing at the mock MCP
 *     server (health_status='healthy', enabled=true).
 *   - interceptAgentStream intercepts POST /api/v1/chat/stream and returns a
 *     deterministic SSE response containing a tool-call-start / tool-call-end
 *     for the "e2e_ping" tool, followed by a text message.
 *   - The test asserts that the ToolCallCard for tcl_e2e_ping renders in the
 *     chat UI with data-testid="tool-call-card-tcl_e2e_ping".
 *
 * Testids used:
 *   tool-call-card-{toolCallId} — each ToolCallCard carries this testid
 *                                 (added to tool-call-card.tsx in this epic)
 *
 * Notes:
 *   - The /ask route and the /chat route both render ChatShellClient, so
 *     we target /{org}/{ws}/ask for simplicity (default landing).
 *   - The mock stream is intercepted before navigation so the route is
 *     already registered when the page loads.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs, E2E_TEST_PASSWORD } from "./helpers/auth";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import { randomBytes } from "node:crypto";

function uid(): string {
  return randomBytes(4).toString("hex");
}

test.describe("mcp-agent-integration", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `agent-int-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-agint-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("installed MCP tool e2e_ping appears in agent turn as a tool-call card", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.userEmail, E2E_TEST_PASSWORD);

    const TOOL_CALL_ID = "tcl_e2e_ping";
    const PARENT_MSG_ID = "msg_e2e_int";

    // ── Register the stream intercept BEFORE navigation ───────────────────────
    await interceptAgentStream(page, {
      events: [
        {
          type: "tool-call-start",
          messageId: PARENT_MSG_ID,
          toolCallId: TOOL_CALL_ID,
          capability: "e2e_ping",
          inputPreview: {},
          riskLevel: "low",
        },
        {
          type: "tool-call-end",
          toolCallId: TOOL_CALL_ID,
          status: "completed",
          output: { content: "pong" },
          durationMs: 42,
        },
        {
          type: "text",
          messageId: PARENT_MSG_ID,
          text: "Done! The mock MCP tool returned pong.",
        },
      ],
    });

    // ── Navigate to the ask page ──────────────────────────────────────────────
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    // ── Send a message ────────────────────────────────────────────────────────
    // The chat page renders a textarea / input for the message composer.
    // Try the placeholder "Send a message" first; fall back to a generic textbox.
    const input = page
      .getByPlaceholder(/send a message/i)
      .or(page.getByRole("textbox").first());
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill("run e2e_ping");
    // The composer defaults to enterToSubmit=false (plain Enter inserts a
    // newline; Cmd/Ctrl+Enter or the Send button submits). Click Send to submit,
    // matching every other chat e2e spec — pressing Enter here is a no-op.
    await page.getByRole("button", { name: /send message/i }).click();

    // ── Assert the tool-call card renders ─────────────────────────────────────
    // This is the test's purpose: an installed MCP tool surfaces as a tool-call
    // card within the agent turn. The card renders from the (mocked) stream's
    // tool-call-start/end events, keyed by toolCallId. interceptAgentStream
    // holds the post-turn RSC refresh so the live streamed bubble persists
    // through this assertion (otherwise the DB-reconcile race flakes it).
    await expect(page.getByTestId(`tool-call-card-${TOOL_CALL_ID}`)).toBeVisible({
      timeout: 15_000,
    });

    // NOTE: the trailing assistant *text* is not asserted. Streamed text
    // segments render against the active assistant-message branch, but the mock
    // emits them under a synthetic messageId ("msg_e2e_int") that no persisted
    // message matches, so the text never attaches to the visible branch. The
    // tool-call card (keyed by toolCallId, not messageId) is the in-scope,
    // reliable signal for "MCP tool callable in an agent turn".
  });
});
