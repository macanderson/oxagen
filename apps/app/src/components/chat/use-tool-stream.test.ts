/**
 * use-tool-stream.test.ts — unit tests for the SSE reducer.
 *
 * The reducer and INITIAL_STATE are pure (state, action) => state — no React,
 * no DOM. Tests run in the default node environment. The "use client" directive
 * in the source file is treated as a comment by Node; it does not affect imports.
 *
 * Covers:
 *   text events          — append for same messageId; separate entries for different
 *   tool-call-start      — creates running entry with expected shape
 *   tool-call-output     — appends to stdout/stderr channel on existing entry; no-op on unknown id
 *   tool-call-end        — sets status/output/durationMs on existing; no-op on unknown id
 *   approval-required    — creates pending approval; hasBlockingApproval logic
 *   approval-resolved    — sets resolution; no-op on unknown id; reset clears pending state
 *   plan-proposed        — creates plan in "pending" state
 *   plan-resolved        — sets decision; no-op on unknown id
 *   subagent-dispatched  — creates fanout with running children
 *   subagent-completed   — sets status/results; no-op on unknown id
 *   memory-recalled      — keyed by queryId
 *   memory-written       — keyed by memoryId
 *   component            — keyed by toolCallId
 *   usage                — stores turnUsage
 *   reset                — returns INITIAL_STATE reference; resolves pending state
 *   unknown event type   — state unchanged (same reference)
 */

// ---------------------------------------------------------------------------
// Module-level mock for React (the source starts with "use client" and imports
// React — we stub the useReducer/useCallback/useMemo/useRef hooks so the file
// can be imported in node without a DOM.
// ---------------------------------------------------------------------------

vi.mock("react", () => ({
  default: {},
  useReducer: vi.fn(),
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (init: unknown) => ({ current: init }),
}));

import { describe, it, expect, vi } from "vitest";
import { reducer, INITIAL_STATE } from "./use-tool-stream";
import type { ToolStreamState } from "./use-tool-stream";
import type { StreamEvent } from "./stream-event-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function event(e: StreamEvent): Parameters<typeof reducer>[1] {
  return { type: "event", event: e };
}

const TOOL_ID = "tc-1";
const MSG_ID = "msg-1";

// A minimal running tool-call entry in state
function stateWithRunningTool(overrides?: Partial<ToolStreamState>): ToolStreamState {
  const s = reducer(INITIAL_STATE, event({
    type: "tool-call-start",
    toolCallId: TOOL_ID,
    messageId: MSG_ID,
    capability: "fs.read",
    inputPreview: { path: "/tmp/x" },
    riskLevel: "low",
  }));
  return { ...s, ...overrides };
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("returns the INITIAL_STATE value", () => {
    const s = stateWithRunningTool();
    const next = reducer(s, { type: "reset" });
    expect(next).toEqual(INITIAL_STATE);
  });

  it("clears a pending approval when reset fires mid-stream", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "approval-required",
      approvalId: "apr-1",
      capability: "fs.write",
      inputPreview: {},
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    expect(Object.keys(s.pendingApprovals)).toHaveLength(1);
    s = reducer(s, { type: "reset" });
    expect(Object.keys(s.pendingApprovals)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// text events
// ---------------------------------------------------------------------------

describe("text events", () => {
  it("appends text for the same messageId", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: MSG_ID, text: "Hello" }));
    s = reducer(s, event({ type: "text", messageId: MSG_ID, text: ", world" }));
    expect(s.messages[MSG_ID]?.text).toBe("Hello, world");
  });

  it("creates separate entries for different messageIds", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: "a", text: "A" }));
    s = reducer(s, event({ type: "text", messageId: "b", text: "B" }));
    expect(s.messages["a"]?.text).toBe("A");
    expect(s.messages["b"]?.text).toBe("B");
  });

  it("starts with empty string when messageId is first seen", () => {
    const s = reducer(INITIAL_STATE, event({ type: "text", messageId: "new", text: "Hi" }));
    expect(s.messages["new"]?.text).toBe("Hi");
  });
});

// ---------------------------------------------------------------------------
// tool-call-start
// ---------------------------------------------------------------------------

describe("tool-call-start", () => {
  it("creates a running entry keyed by toolCallId", () => {
    const s = stateWithRunningTool();
    const tc = s.toolCalls[TOOL_ID];
    expect(tc).toBeDefined();
    expect(tc?.status).toBe("running");
    expect(tc?.capability).toBe("fs.read");
    expect(tc?.stdout).toBe("");
    expect(tc?.stderr).toBe("");
    expect(typeof tc?.startedAt).toBe("number");
  });

  it("preserves existing toolCalls when adding a new one", () => {
    let s = stateWithRunningTool();
    s = reducer(s, event({
      type: "tool-call-start",
      toolCallId: "tc-2",
      messageId: MSG_ID,
      capability: "fetch_web_page",
      inputPreview: {},
      riskLevel: "medium",
    }));
    expect(Object.keys(s.toolCalls)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// tool-call-output
// ---------------------------------------------------------------------------

describe("tool-call-output", () => {
  it("appends to stdout channel", () => {
    let s = stateWithRunningTool();
    s = reducer(s, event({ type: "tool-call-output", toolCallId: TOOL_ID, chunk: { channel: "stdout", data: "line1\n" } }));
    s = reducer(s, event({ type: "tool-call-output", toolCallId: TOOL_ID, chunk: { channel: "stdout", data: "line2\n" } }));
    expect(s.toolCalls[TOOL_ID]?.stdout).toBe("line1\nline2\n");
  });

  it("appends to stderr channel separately from stdout", () => {
    let s = stateWithRunningTool();
    s = reducer(s, event({ type: "tool-call-output", toolCallId: TOOL_ID, chunk: { channel: "stdout", data: "out" } }));
    s = reducer(s, event({ type: "tool-call-output", toolCallId: TOOL_ID, chunk: { channel: "stderr", data: "err" } }));
    expect(s.toolCalls[TOOL_ID]?.stdout).toBe("out");
    expect(s.toolCalls[TOOL_ID]?.stderr).toBe("err");
  });

  it("returns the same state reference when toolCallId is unknown", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "tool-call-output", toolCallId: "unknown", chunk: { channel: "stdout", data: "x" } }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// tool-call-end
// ---------------------------------------------------------------------------

describe("tool-call-end", () => {
  it("sets status, output, and durationMs", () => {
    let s = stateWithRunningTool();
    s = reducer(s, event({
      type: "tool-call-end",
      toolCallId: TOOL_ID,
      status: "completed",
      output: { data: 42 },
      durationMs: 123,
    }));
    const tc = s.toolCalls[TOOL_ID]!;
    expect(tc.status).toBe("completed");
    expect(tc.output).toEqual({ data: 42 });
    expect(tc.durationMs).toBe(123);
  });

  it("sets errorReason on failed status", () => {
    let s = stateWithRunningTool();
    s = reducer(s, event({
      type: "tool-call-end",
      toolCallId: TOOL_ID,
      status: "failed",
      errorReason: "timeout",
      durationMs: 500,
    }));
    expect(s.toolCalls[TOOL_ID]?.status).toBe("failed");
    expect(s.toolCalls[TOOL_ID]?.errorReason).toBe("timeout");
  });

  it("returns the same state reference when toolCallId is unknown", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "tool-call-end", toolCallId: "nope", status: "completed", durationMs: 0 }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// approval-required / approval-resolved
// ---------------------------------------------------------------------------

describe("approval-required", () => {
  it("creates a pending approval keyed by approvalId", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "approval-required",
      approvalId: "apr-1",
      capability: "fs.write",
      inputPreview: { path: "/etc/passwd" },
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    const a = s.pendingApprovals["apr-1"];
    expect(a).toBeDefined();
    expect(a?.resolution).toBeUndefined();
    expect(a?.capability).toBe("fs.write");
  });
});

describe("approval-resolved", () => {
  it("sets resolution on an existing approval", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "approval-required",
      approvalId: "apr-1",
      capability: "fs.write",
      inputPreview: {},
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    s = reducer(s, event({ type: "approval-resolved", approvalId: "apr-1", resolution: "approved" }));
    expect(s.pendingApprovals["apr-1"]?.resolution).toBe("approved");
  });

  it("returns same state reference on unknown approvalId", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "approval-resolved", approvalId: "nope", resolution: "denied" }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// consent-required / consent-resolved (OXA-816 external-MCP first-use consent)
// ---------------------------------------------------------------------------

describe("consent-required", () => {
  it("creates a pending consent keyed by approvalId and adds a consent order key", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "consent-required",
      approvalId: "apr-c1",
      capability: "mcp.srv_1.list_prs",
      serverId: "srv_1",
      toolName: "list_prs",
      inputPreview: { repo: "oxagen" },
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    const c = s.pendingConsents["apr-c1"];
    expect(c).toBeDefined();
    expect(c?.resolution).toBeUndefined();
    expect(c?.toolName).toBe("list_prs");
    expect(c?.serverId).toBe("srv_1");
    expect(s.order).toContain("consent:apr-c1");
  });
});

describe("consent-resolved", () => {
  it("sets resolution on an existing consent", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "consent-required",
      approvalId: "apr-c1",
      capability: "mcp.srv_1.list_prs",
      serverId: "srv_1",
      toolName: "list_prs",
      inputPreview: {},
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    s = reducer(s, event({ type: "consent-resolved", approvalId: "apr-c1", resolution: "granted" }));
    expect(s.pendingConsents["apr-c1"]?.resolution).toBe("granted");
  });

  it("returns the same state reference on an unknown approvalId", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "consent-resolved", approvalId: "nope", resolution: "denied" }));
    expect(next).toBe(s);
  });

  it("reset clears pending consents", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "consent-required",
      approvalId: "apr-c1",
      capability: "mcp.srv_1.list_prs",
      serverId: "srv_1",
      toolName: "list_prs",
      inputPreview: {},
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    expect(Object.keys(s.pendingConsents)).toHaveLength(1);
    s = reducer(s, { type: "reset" });
    expect(Object.keys(s.pendingConsents)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasBlockingApproval logic (derived from pendingApprovals)
// ---------------------------------------------------------------------------

describe("hasBlockingApproval logic", () => {
  it("is true when there is at least one approval without a resolution", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "approval-required",
      approvalId: "apr-1",
      capability: "fs.write",
      inputPreview: {},
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    // Derive hasBlockingApproval the same way the hook does
    const hasBlocking = Object.values(s.pendingApprovals).some((a) => a.resolution === undefined);
    expect(hasBlocking).toBe(true);
  });

  it("is false when all approvals have a resolution", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "approval-required",
      approvalId: "apr-1",
      capability: "fs.write",
      inputPreview: {},
      riskLevel: "high",
      expiresAt: "2099-01-01T00:00:00Z",
    }));
    s = reducer(s, event({ type: "approval-resolved", approvalId: "apr-1", resolution: "approved" }));
    const hasBlocking = Object.values(s.pendingApprovals).some((a) => a.resolution === undefined);
    expect(hasBlocking).toBe(false);
  });

  it("is false on INITIAL_STATE (empty map)", () => {
    const hasBlocking = Object.values(INITIAL_STATE.pendingApprovals).some((a) => a.resolution === undefined);
    expect(hasBlocking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// plan-proposed / plan-resolved
// ---------------------------------------------------------------------------

describe("plan-proposed", () => {
  it("creates a plan in pending status keyed by planId", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "plan-proposed",
      planId: "plan-1",
      title: "Research task",
      steps: [{ id: "s1", summary: "Look it up", intent: "search", capability: "search_web", dependsOn: [] }],
      rationale: "Because",
    }));
    const p = s.plans["plan-1"];
    expect(p?.status).toBe("pending");
    expect(p?.title).toBe("Research task");
    expect(p?.steps).toHaveLength(1);
  });
});

describe("plan-resolved", () => {
  it("sets decision on an existing plan", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "plan-proposed",
      planId: "plan-1",
      title: "T",
      steps: [],
    }));
    s = reducer(s, event({ type: "plan-resolved", planId: "plan-1", decision: "approved" }));
    expect(s.plans["plan-1"]?.status).toBe("approved");
  });

  it("returns same state reference on unknown planId", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "plan-resolved", planId: "nope", decision: "denied" }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// subagent-dispatched / subagent-completed
// ---------------------------------------------------------------------------

describe("subagent-dispatched", () => {
  it("creates fanout with running status and children", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "subagent-dispatched",
      fanoutId: "fan-1",
      parentMessageId: MSG_ID,
      children: [
        { childMessageId: "child-1", capability: "fetch_web_page", label: "Fetch" },
      ],
    }));
    const f = s.activeFanouts["fan-1"];
    expect(f?.status).toBe("running");
    expect(f?.children).toHaveLength(1);
    expect(f?.children[0]?.status).toBe("running");
  });
});

describe("subagent-completed", () => {
  it("sets status and results on existing fanout", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "subagent-dispatched",
      fanoutId: "fan-1",
      parentMessageId: MSG_ID,
      children: [{ childMessageId: "child-1", capability: "fetch_web_page" }],
    }));
    s = reducer(s, event({
      type: "subagent-completed",
      fanoutId: "fan-1",
      status: "completed",
      results: [{ childMessageId: "child-1", output: { ok: true } }],
    }));
    const f = s.activeFanouts["fan-1"]!;
    expect(f.status).toBe("completed");
    expect(f.results).toHaveLength(1);
  });

  it("returns same state reference on unknown fanoutId", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "subagent-completed", fanoutId: "nope", status: "completed" }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// memory-recalled / memory-written
// ---------------------------------------------------------------------------

describe("memory-recalled", () => {
  it("keyed by queryId with memories array", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "memory-recalled",
      queryId: "q-1",
      memories: [
        {
          id: "m-1",
          lesson: "Don't do that",
          memoryClass: "FACT",
          memoryKind: "constraint",
          confidenceScore: 95,
          enforcementScore: 100,
          score: 0.9,
        },
      ],
    }));
    const r = s.memoryRecalls["q-1"];
    expect(r?.queryId).toBe("q-1");
    expect(r?.memories).toHaveLength(1);
  });

  it("overwrites for the same queryId", () => {
    let s = reducer(INITIAL_STATE, event({ type: "memory-recalled", queryId: "q-1", memories: [] }));
    s = reducer(
      s,
      event({
        type: "memory-recalled",
        queryId: "q-1",
        memories: [
          {
            id: "m-2",
            lesson: "x",
            memoryClass: "OBSERVATION",
            memoryKind: "gotcha",
            confidenceScore: 50,
            enforcementScore: null,
            score: 0.5,
          },
        ],
      }),
    );
    expect(s.memoryRecalls["q-1"]?.memories).toHaveLength(1);
  });
});

describe("memory-written", () => {
  it("keyed by memoryId with nodeRef and memoryClass", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "memory-written",
      memoryId: "mem-1",
      nodeRef: "node://mem-1",
      memoryClass: "FACT",
      enforcementScore: 100,
    }));
    const w = s.memoryWrites["mem-1"];
    expect(w?.memoryId).toBe("mem-1");
    expect(w?.nodeRef).toBe("node://mem-1");
    expect(w?.memoryClass).toBe("FACT");
    expect(w?.enforcementScore).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

describe("component event", () => {
  it("keyed by toolCallId with componentId and props", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "component",
      toolCallId: TOOL_ID,
      componentId: "svg-preview",
      props: { svg: "<svg/>" },
    }));
    const c = s.components[TOOL_ID];
    expect(c?.componentId).toBe("svg-preview");
    expect(c?.props).toEqual({ svg: "<svg/>" });
  });

  it("overwrites for the same toolCallId", () => {
    let s = reducer(INITIAL_STATE, event({ type: "component", toolCallId: TOOL_ID, componentId: "a", props: {} }));
    s = reducer(s, event({ type: "component", toolCallId: TOOL_ID, componentId: "b", props: { x: 1 } }));
    expect(s.components[TOOL_ID]?.componentId).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe("usage event", () => {
  it("stores turnUsage from the event", () => {
    const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, creditsCharged: 15 };
    const s = reducer(INITIAL_STATE, event({ type: "usage", usage }));
    expect(s.turnUsage).toEqual(usage);
  });

  it("replaces prior turnUsage on a second usage event", () => {
    let s = reducer(INITIAL_STATE, event({ type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
    s = reducer(s, event({ type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }));
    expect(s.turnUsage?.totalTokens).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// suggested-prompts event (ephemeral per-turn next-step chips)
// ---------------------------------------------------------------------------

describe("suggested-prompts event", () => {
  const trio = [
    { label: "Turn Into An Agent", prompt: "Create an agent that does this." },
    { label: "Automate This", prompt: "Automate this on a schedule." },
    { label: "Add To Graph", prompt: "Wire this into the knowledge graph." },
  ];

  it("initial state has null suggestedPrompts", () => {
    expect(INITIAL_STATE.suggestedPrompts).toBeNull();
  });

  it("stores the suggestions from the event", () => {
    const s = reducer(
      INITIAL_STATE,
      event({ type: "suggested-prompts", suggestions: trio }),
    );
    expect(s.suggestedPrompts).toEqual(trio);
  });

  it("replaces the prior turn's suggestions on a second event", () => {
    let s = reducer(
      INITIAL_STATE,
      event({ type: "suggested-prompts", suggestions: trio }),
    );
    const next = [{ label: "Publish It", prompt: "Publish to the marketplace." }];
    s = reducer(s, event({ type: "suggested-prompts", suggestions: next }));
    expect(s.suggestedPrompts).toEqual(next);
  });

  it("ignores an empty payload (keeps prior suggestions)", () => {
    let s = reducer(
      INITIAL_STATE,
      event({ type: "suggested-prompts", suggestions: trio }),
    );
    s = reducer(s, event({ type: "suggested-prompts", suggestions: [] }));
    expect(s.suggestedPrompts).toEqual(trio);
  });

  it("reset clears suggestedPrompts back to null", () => {
    let s = reducer(
      INITIAL_STATE,
      event({ type: "suggested-prompts", suggestions: trio }),
    );
    s = reducer(s, { type: "reset" });
    expect(s.suggestedPrompts).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// error event (turn-level failure → toast, never inline text)
// ---------------------------------------------------------------------------

describe("error event", () => {
  it("stores turnError without touching textSegments or messages", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "error",
      messageId: MSG_ID,
      code: "insufficient_credits",
      message: "Insufficient credits: your balance is empty.",
    }));
    expect(s.turnError).toEqual({
      code: "insufficient_credits",
      message: "Insufficient credits: your balance is empty.",
    });
    // Crucially: the error must NOT render inline — no text segment, no message,
    // no timeline order entry.
    expect(Object.keys(s.textSegments)).toHaveLength(0);
    expect(Object.keys(s.messages)).toHaveLength(0);
    expect(s.order).toHaveLength(0);
    expect(s.activeTextKey).toBeNull();
  });

  it("stores turnError without a code when none is provided", () => {
    const s = reducer(INITIAL_STATE, event({
      type: "error",
      messageId: MSG_ID,
      message: "Gateway timeout",
    }));
    expect(s.turnError).toEqual({ message: "Gateway timeout" });
    expect(s.turnError?.code).toBeUndefined();
  });

  it("breaks the active text segment so trailing prose is not appended to it", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: MSG_ID, text: "partial" }));
    expect(s.activeTextKey).not.toBeNull();
    s = reducer(s, event({ type: "error", messageId: MSG_ID, message: "boom" }));
    expect(s.activeTextKey).toBeNull();
    // Prior partial text is preserved; the error is held separately.
    expect(s.textSegments[`text:${MSG_ID}:0`]?.text).toBe("partial");
    expect(s.turnError?.message).toBe("boom");
  });

  it("a new error event replaces the prior turnError", () => {
    let s = reducer(INITIAL_STATE, event({ type: "error", messageId: MSG_ID, message: "first" }));
    s = reducer(s, event({ type: "error", messageId: MSG_ID, code: "rate_limited", message: "second" }));
    expect(s.turnError).toEqual({ code: "rate_limited", message: "second" });
  });

  it("reset clears turnError", () => {
    let s = reducer(INITIAL_STATE, event({ type: "error", messageId: MSG_ID, message: "boom" }));
    expect(s.turnError).toBeDefined();
    s = reducer(s, { type: "reset" });
    expect(s.turnError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reasoning-start / reasoning-delta / reasoning-end
// ---------------------------------------------------------------------------

describe("reasoning events", () => {
  it("creates a thinking segment, appends deltas, and finalizes on end", () => {
    let s = reducer(INITIAL_STATE, event({ type: "reasoning-start", messageId: MSG_ID, reasoningId: "r-1" }));
    expect(s.reasonings["r-1"]?.status).toBe("thinking");
    expect(s.order).toContain("reasoning:r-1");

    s = reducer(s, event({ type: "reasoning-delta", reasoningId: "r-1", text: "Let me " }));
    s = reducer(s, event({ type: "reasoning-delta", reasoningId: "r-1", text: "think." }));
    expect(s.reasonings["r-1"]?.text).toBe("Let me think.");

    s = reducer(s, event({ type: "reasoning-end", reasoningId: "r-1", durationMs: 1200 }));
    expect(s.reasonings["r-1"]?.status).toBe("done");
    expect(s.reasonings["r-1"]?.durationMs).toBe(1200);
  });

  it("breaks the active text segment so text after reasoning is a new node", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: MSG_ID, text: "Answer A" }));
    expect(s.activeTextKey).not.toBeNull();
    s = reducer(s, event({ type: "reasoning-start", messageId: MSG_ID, reasoningId: "r-1" }));
    expect(s.activeTextKey).toBeNull();
  });

  it("creates a defensive entry when reasoning-delta arrives without a start", () => {
    const s = reducer(INITIAL_STATE, event({ type: "reasoning-delta", reasoningId: "r-x", text: "orphan" }));
    expect(s.reasonings["r-x"]?.text).toBe("orphan");
    expect(s.order).toContain("reasoning:r-x");
  });

  it("returns same state reference on reasoning-end for an unknown id", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "reasoning-end", reasoningId: "nope", durationMs: 0 }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// step-start / step-finish
// ---------------------------------------------------------------------------

describe("step events", () => {
  it("creates a running step and marks it done on finish", () => {
    let s = reducer(INITIAL_STATE, event({ type: "step-start", messageId: MSG_ID, stepIndex: 0 }));
    expect(s.steps[0]?.status).toBe("running");
    expect(s.order).toContain("step:0");
    s = reducer(s, event({ type: "step-finish", stepIndex: 0 }));
    expect(s.steps[0]?.status).toBe("done");
  });

  it("returns same state reference on step-finish for an unknown index", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "step-finish", stepIndex: 9 }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// tool-input-start / tool-input-delta (streaming args)
// ---------------------------------------------------------------------------

describe("streaming tool input", () => {
  it("creates a pending tool call and accumulates partial args", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "tool-input-start",
      messageId: MSG_ID,
      toolCallId: TOOL_ID,
      capability: "fs.read",
    }));
    expect(s.toolCalls[TOOL_ID]?.status).toBe("pending");
    expect(s.order).toContain(`tool:${TOOL_ID}`);

    s = reducer(s, event({ type: "tool-input-delta", toolCallId: TOOL_ID, delta: '{"path":' }));
    s = reducer(s, event({ type: "tool-input-delta", toolCallId: TOOL_ID, delta: '"/tmp"}' }));
    expect(s.toolCalls[TOOL_ID]?.partialInput).toBe('{"path":"/tmp"}');
  });

  it("flips pending → running on tool-call-start, preserving startedAt", () => {
    let s = reducer(INITIAL_STATE, event({
      type: "tool-input-start",
      messageId: MSG_ID,
      toolCallId: TOOL_ID,
      capability: "fs.read",
    }));
    const startedAt = s.toolCalls[TOOL_ID]?.startedAt;
    s = reducer(s, event({
      type: "tool-call-start",
      toolCallId: TOOL_ID,
      messageId: MSG_ID,
      capability: "fs.read",
      inputPreview: { path: "/tmp" },
      riskLevel: "low",
    }));
    expect(s.toolCalls[TOOL_ID]?.status).toBe("running");
    expect(s.toolCalls[TOOL_ID]?.inputPreview).toEqual({ path: "/tmp" });
    expect(s.toolCalls[TOOL_ID]?.startedAt).toBe(startedAt);
    // The order has a single tool entry, not two.
    expect(s.order.filter((k) => k === `tool:${TOOL_ID}`)).toHaveLength(1);
  });

  it("returns same state reference on tool-input-delta for an unknown id", () => {
    const s = INITIAL_STATE;
    const next = reducer(s, event({ type: "tool-input-delta", toolCallId: "nope", delta: "x" }));
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// ordered timeline + interleaved text segments
// ---------------------------------------------------------------------------

describe("ordered timeline", () => {
  it("records entities in first-appearance order and splits text around a tool", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: MSG_ID, text: "before " }));
    s = reducer(s, event({
      type: "tool-call-start",
      toolCallId: TOOL_ID,
      messageId: MSG_ID,
      capability: "fs.read",
      inputPreview: {},
      riskLevel: "low",
    }));
    s = reducer(s, event({ type: "text", messageId: MSG_ID, text: "after" }));

    expect(s.order).toEqual([`text:${MSG_ID}:0`, `tool:${TOOL_ID}`, `text:${MSG_ID}:2`]);
    expect(s.textSegments[`text:${MSG_ID}:0`]?.text).toBe("before ");
    expect(s.textSegments[`text:${MSG_ID}:2`]?.text).toBe("after");
    // The full accumulated message text is still available.
    expect(s.messages[MSG_ID]?.text).toBe("before after");
  });

  it("keeps a contiguous run of text deltas in a single segment", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: MSG_ID, text: "a" }));
    s = reducer(s, event({ type: "text", messageId: MSG_ID, text: "b" }));
    expect(s.order).toEqual([`text:${MSG_ID}:0`]);
    expect(s.textSegments[`text:${MSG_ID}:0`]?.text).toBe("ab");
  });
});

// ---------------------------------------------------------------------------
// Unknown event type
// ---------------------------------------------------------------------------

describe("unknown event type", () => {
  it("returns state unchanged for an unrecognised event type", () => {
    const s = stateWithRunningTool();
    // Cast to any to inject a fake event type that the switch default handles
    const next = reducer(s, { type: "event", event: { type: "unknown-future-event" } as unknown as StreamEvent });
    expect(next).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// warning events (non-fatal advisories, e.g. persist-to-history failed)
// ---------------------------------------------------------------------------

describe("warning events", () => {
  it("stashes turnWarning without marking the turn failed", () => {
    const s = reducer(
      INITIAL_STATE,
      event({ type: "warning", message: "reply not saved", code: "assistant_persist_failed" }),
    );
    expect(s.turnWarning).toEqual({ message: "reply not saved", code: "assistant_persist_failed" });
    // A warning is NON-fatal: it must not populate turnError.
    expect(s.turnError).toBeUndefined();
  });

  it("does not clear an in-progress text segment (turn still succeeding)", () => {
    let s = reducer(INITIAL_STATE, event({ type: "text", messageId: MSG_ID, text: "hi" }));
    const activeBefore = s.activeTextKey;
    s = reducer(s, event({ type: "warning", message: "heads up" }));
    // Unlike an error, a warning leaves the active timeline untouched.
    expect(s.activeTextKey).toBe(activeBefore);
    expect(s.textSegments[`text:${MSG_ID}:0`]?.text).toBe("hi");
  });

  it("omits code when the warning has none", () => {
    const s = reducer(INITIAL_STATE, event({ type: "warning", message: "just so you know" }));
    expect(s.turnWarning).toEqual({ message: "just so you know" });
  });
});

describe("budget-tick (chat_ux_v2 live cost estimate)", () => {
  it("stores the latest cumulative cost and resets with the turn", () => {
    let s = reducer(
      INITIAL_STATE,
      event({ type: "budget-tick", costUsd: 0.12, limitUsd: 2 }),
    );
    expect(s.turnCostUsd).toBe(0.12);
    s = reducer(s, event({ type: "budget-tick", costUsd: 0.31, limitUsd: 2 }));
    expect(s.turnCostUsd).toBe(0.31);
    s = reducer(s, { type: "reset" });
    expect(s.turnCostUsd).toBeUndefined();
  });

  it("does not disturb the blocking budget-notice state", () => {
    let s = reducer(
      INITIAL_STATE,
      event({
        type: "budget-notice",
        state: "within_grace",
        costUsd: 2.1,
        limitUsd: 2,
        mode: "grace",
      }),
    );
    s = reducer(s, event({ type: "budget-tick", costUsd: 2.2, limitUsd: 2 }));
    expect(s.turnBudgetNotice?.state).toBe("within_grace");
    expect(s.turnCostUsd).toBe(2.2);
  });
});
