import type { Page, Route } from "@playwright/test";
import type { StreamEvent } from "../../src/components/chat/stream-event-types";

export interface InterceptOptions {
  events: StreamEvent[];
  /** Delay between events in milliseconds. Defaults to 80ms. */
  delayMs?: number;
  /** URL glob to intercept. Defaults to the chat send endpoint. */
  urlGlob?: string;
  /**
   * Hold the post-turn RSC refresh so the streamed (live) bubbles stay visible
   * for assertions. Defaults to true.
   *
   * Why: after a turn the chat shell fires router.refresh() to reconcile the
   * live SSE state against the now-persisted assistant reply. The mock
   * intercepts the SSE stream but cannot persist a reply to Postgres, so the
   * refresh re-renders the conversation from the DB (user message only) and the
   * [messages] effect reset()s the streamed bubbles — wiping the very cards/text
   * the spec asserts on (a race that flakes). Holding the RSC GET keeps the live
   * state in place for the test. The initial page.goto is a full-document load
   * (no RSC header), so navigation is unaffected.
   */
  holdRefresh?: boolean;
}

// Intercept the chat-stream POST and return a deterministic SSE response
// that yields the supplied events in order with realistic inter-event
// delays. We also intercept upstream LLM calls so the runtime never reaches
// Anthropic / any provider during the test.
export async function interceptAgentStream(
  page: Page,
  opts: InterceptOptions,
): Promise<void> {
  const delayMs = opts.delayMs ?? 80;
  const urlGlob = opts.urlGlob ?? "**/api/v1/chat/stream";

  // Disable CSS animations and the rAF-based StreamingText reveal so that
  // streamed text is immediately readable in the DOM without waiting for
  // animation frames. The MotionProvider wraps motion/react with
  // reducedMotion="user", so emulating prefers-reduced-motion:reduce causes
  // useReducedMotion() to return true — StreamingText renders the full
  // accumulated text in its first paint instead of counting up from 0.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.route("**/api/anthropic/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, mocked: true }),
    }),
  );

  await page.route(urlGlob, async (route: Route) => {
    const chunks: string[] = [];
    for (const ev of opts.events) {
      chunks.push(`data: ${JSON.stringify(ev)}\n\n`);
    }
    chunks.push("event: done\ndata: [DONE]\n\n");

    // Concatenate into a single SSE body. Pacing of individual events
    // matters less than ordering for the assertions in
    // `agent-runtime-flow.spec.ts`, so we wait once before responding to
    // emulate end-to-end stream latency in a deterministic way.
    await new Promise((r) => setTimeout(r, delayMs));

    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: chunks.join(""),
    });
  });

  if (opts.holdRefresh ?? true) {
    // Hold the post-turn RSC refresh of the conversation page so the live
    // streamed bubbles persist through the assertions (see holdRefresh docs).
    // Match only RSC GETs (header `rsc: 1`) to the /ask or /chat route; the
    // full-document page.goto has no RSC header and falls through to continue().
    await page.route(
      (url) => /\/(ask|chat)(\?|$)/.test(`${url.pathname}${url.search}`),
      async (route: Route) => {
        const req = route.request();
        if (req.method() === "GET" && req.headers()["rsc"] === "1") {
          // Never fulfill: the refresh stays pending, so the [messages]
          // reconcile that would reset() the streamed bubbles never fires.
          return;
        }
        await route.continue();
      },
    );
  }
}

// Helper: build the canonical set of stream events for the §10 scenario.
// Exported so the spec stays declarative and reusable.
export function scriptedScenarioEvents(args: {
  parentMessageId: string;
}): StreamEvent[] {
  const m = args.parentMessageId;
  return [
    {
      type: "plan-proposed",
      planId: "pln_001",
      title: "Analyze repo and summarize",
      steps: [
        {
          id: "s1",
          summary: "Recall prior summaries",
          intent: "Pull related memories before fanning out.",
          capability: "recall_memory",
          dependsOn: [],
        },
        {
          id: "s2",
          summary: "Run code over each subdir",
          intent: "Fan out three sandboxed code runs.",
          capability: "dispatch_subagent",
          dependsOn: ["s1"],
        },
        {
          id: "s3",
          summary: "Write summary memory",
          intent: "Persist the aggregated insight.",
          capability: "write_memory",
          dependsOn: ["s2"],
        },
      ],
    },
    {
      type: "approval-required",
      approvalId: "apr_001",
      capability: "agent.plan",
      inputPreview: { planId: "pln_001" },
      riskLevel: "high",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
    {
      type: "approval-resolved",
      approvalId: "apr_001",
      resolution: "approved",
    },
    { type: "plan-resolved", planId: "pln_001", decision: "approved" },
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_recall",
      capability: "recall_memory",
      inputPreview: { query: "workspace summary" },
      riskLevel: "low",
    },
    {
      type: "memory-recalled",
      queryId: "qry_001",
      memories: [
        {
          id: "mem_1",
          lesson: "Prior summary noted three top-level packages.",
          memoryClass: "OBSERVATION",
          memoryKind: "routine-change",
          confidenceScore: 65,
          enforcementScore: null,
          score: 0.81,
        },
      ],
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_recall",
      status: "completed",
      output: { count: 1 },
      durationMs: 120,
    },
    {
      type: "subagent-dispatched",
      fanoutId: "fan_001",
      parentMessageId: m,
      children: [
        {
          childMessageId: "msg_c1",
          capability: "execute_code",
          label: "apps/app",
        },
        {
          childMessageId: "msg_c2",
          capability: "execute_code",
          label: "apps/mcp",
        },
        {
          childMessageId: "msg_c3",
          capability: "execute_code",
          label: "packages",
        },
      ],
    },
    {
      type: "tool-call-start",
      messageId: "msg_c1",
      toolCallId: "tcl_code1",
      capability: "execute_code",
      inputPreview: { language: "node", code: "console.log('apps/app');" },
      riskLevel: "medium",
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_code1",
      status: "completed",
      output: { exitCode: 0 },
      durationMs: 320,
    },
    {
      type: "tool-call-start",
      messageId: "msg_c2",
      toolCallId: "tcl_code2",
      capability: "execute_code",
      inputPreview: { language: "node", code: "console.log('apps/mcp');" },
      riskLevel: "medium",
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_code2",
      status: "completed",
      output: { exitCode: 0 },
      durationMs: 290,
    },
    {
      type: "tool-call-start",
      messageId: "msg_c3",
      toolCallId: "tcl_code3",
      capability: "execute_code",
      inputPreview: { language: "node", code: "console.log('packages');" },
      riskLevel: "medium",
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_code3",
      status: "completed",
      output: { exitCode: 0 },
      durationMs: 410,
    },
    {
      type: "subagent-completed",
      fanoutId: "fan_001",
      status: "completed",
      results: [
        { childMessageId: "msg_c1", output: { files: 42 } },
        { childMessageId: "msg_c2", output: { files: 17 } },
        { childMessageId: "msg_c3", output: { files: 88 } },
      ],
    },
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_write",
      capability: "write_memory",
      inputPreview: {
        lesson: "Workspace has 147 source files across 3 packages.",
      },
      riskLevel: "low",
    },
    {
      type: "memory-written",
      memoryId: "mem_new",
      nodeRef: "AgentMemory:mem_new",
      memoryClass: "FACT",
      enforcementScore: 100,
    },
    {
      type: "tool-call-end",
      toolCallId: "tcl_write",
      status: "completed",
      output: { ok: true },
      durationMs: 95,
    },
    { type: "text", messageId: m, text: "Done." },
  ];
}
