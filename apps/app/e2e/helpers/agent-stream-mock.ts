import type { Page, Route } from "@playwright/test";
import type { StreamEvent } from "../../src/components/chat/stream-event-types";

export interface InterceptOptions {
  events: StreamEvent[];
  /** Delay between events in milliseconds. Defaults to 80ms. */
  delayMs?: number;
  /** URL glob to intercept. Defaults to the chat send endpoint. */
  urlGlob?: string;
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
  // The chat stream route is versioned under /api/v1 (OXA-1502), so the client
  // POSTs to /api/v1/chat/stream. The glob must include the `v1` segment or it
  // silently fails to intercept and the test reaches the real LLM call.
  const urlGlob = opts.urlGlob ?? "**/api/v1/chat/**";

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
          capability: "agent.memory.recall",
          dependsOn: [],
        },
        {
          id: "s2",
          summary: "Run code over each subdir",
          intent: "Fan out three sandboxed code runs.",
          capability: "agent.subagent.dispatch",
          dependsOn: ["s1"],
        },
        {
          id: "s3",
          summary: "Write summary memory",
          intent: "Persist the aggregated insight.",
          capability: "agent.memory.write",
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
    { type: "approval-resolved", approvalId: "apr_001", resolution: "approved" },
    { type: "plan-resolved", planId: "pln_001", decision: "approved" },
    {
      type: "tool-call-start",
      messageId: m,
      toolCallId: "tcl_recall",
      capability: "agent.memory.recall",
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
          weight: "consider",
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
        { childMessageId: "msg_c1", capability: "agent.code.execute", label: "apps/app" },
        { childMessageId: "msg_c2", capability: "agent.code.execute", label: "apps/mcp" },
        { childMessageId: "msg_c3", capability: "agent.code.execute", label: "packages" },
      ],
    },
    {
      type: "tool-call-start",
      messageId: "msg_c1",
      toolCallId: "tcl_code1",
      capability: "agent.code.execute",
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
      capability: "agent.code.execute",
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
      capability: "agent.code.execute",
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
      capability: "agent.memory.write",
      inputPreview: { lesson: "Workspace has 147 source files across 3 packages." },
      riskLevel: "low",
    },
    {
      type: "memory-written",
      memoryId: "mem_new",
      nodeRef: "AgentMemory:mem_new",
      weight: "fact",
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
