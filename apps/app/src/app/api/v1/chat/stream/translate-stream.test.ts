/**
 * translate-stream.test.ts — unit tests for translateAgentStream, focusing on
 * the credits-charged computation in the usage event.
 *
 * Covers:
 *   (a) usage event emitted with creditsCharged when billing meter succeeds
 *   (b) usage event emitted WITHOUT creditsCharged when billing meter throws
 *       (unknown model id) — graceful degradation, never crashes the turn
 *   (c) no usage event emitted when no finish part arrives (error-before-LLM)
 *   (d) assistantText is accumulated from text-delta parts correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stub @oxagen/billing so we can control what meterCreditsForUsage returns
//    without requiring a real Stripe/DB stack.
vi.mock("@oxagen/billing", () => ({
  meterCreditsForUsage: vi.fn(),
}));

// ── Stub @oxagen/oxagen/capability-meta (used by translate-stream but not
//    relevant to the usage-event tests).
vi.mock("@oxagen/oxagen/capability-meta", () => ({
  resolveRenderDirective: vi.fn(() => null),
}));

import { translateAgentStream } from "./translate-stream";
import type { StreamEvent } from "@/components/chat/stream-event-types";
import { meterCreditsForUsage } from "@oxagen/billing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Part =
  | { type: "text-delta"; text: string }
  | { type: "finish"; totalUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { type: "error"; error: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; output: unknown };

async function* makeStream(parts: Part[]): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

function collectEvents(events: StreamEvent[], type: string) {
  return events.filter((e) => e.type === type);
}

const BASE_ARGS = {
  requestId: "req-1",
  toolNameMap: {},
  orgSlug: "my-org",
  workspaceSlug: "my-ws",
  modelId: "anthropic/claude-sonnet-5",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("translateAgentStream — usage event + credits", () => {
  beforeEach(() => {
    vi.mocked(meterCreditsForUsage).mockReset();
  });

  it("(a) emits usage event with creditsCharged when billing meter succeeds", async () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(42n);

    const events: StreamEvent[] = [];
    const parts: Part[] = [
      { type: "text-delta", text: "Hello" },
      { type: "finish", totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
    ];

    await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    const usageEvents = collectEvents(events, "usage");
    expect(usageEvents).toHaveLength(1);
    const usageEvent = usageEvents[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usageEvent.usage.promptTokens).toBe(100);
    expect(usageEvent.usage.completionTokens).toBe(50);
    expect(usageEvent.usage.totalTokens).toBe(150);
    expect(usageEvent.usage.creditsCharged).toBe(42);

    // Meter must be called with the right model + token counts.
    expect(vi.mocked(meterCreditsForUsage)).toHaveBeenCalledWith({
      model: BASE_ARGS.modelId,
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("(b) emits usage event WITHOUT creditsCharged when billing meter throws", async () => {
    vi.mocked(meterCreditsForUsage).mockImplementation(() => {
      throw new Error("Unknown model id: bogus/model");
    });

    const events: StreamEvent[] = [];
    const parts: Part[] = [
      { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ];

    await translateAgentStream({
      ...BASE_ARGS,
      modelId: "bogus/model",
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    const usageEvents = collectEvents(events, "usage");
    expect(usageEvents).toHaveLength(1);
    const usageEvent = usageEvents[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usageEvent.usage.totalTokens).toBe(15);
    // creditsCharged must be absent (not set to 0 or NaN)
    expect(usageEvent.usage.creditsCharged).toBeUndefined();
  });

  it("(c) emits no usage event when the stream ends without a finish part", async () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(0n);

    const events: StreamEvent[] = [];
    const parts: Part[] = [
      { type: "error", error: "Gateway timeout" },
    ];

    await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    expect(collectEvents(events, "usage")).toHaveLength(0);
    // meterCreditsForUsage must NOT be called (no finish part)
    expect(vi.mocked(meterCreditsForUsage)).not.toHaveBeenCalled();
  });

  it("(d) accumulates assistantText from text-delta parts", async () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(1n);

    const parts: Part[] = [
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
      { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ];

    const { assistantText } = await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: () => {},
    });

    expect(assistantText).toBe("Hello world");
  });
});

describe("translateAgentStream — error part surfaces a structured error event", () => {
  it("emits an `error` event (not text) with parsed code+message for a billing envelope", async () => {
    const envelope = JSON.stringify({
      error: {
        code: "insufficient_credits",
        message: "Insufficient credits: your balance is empty. Please add credits to continue.",
      },
      requestId: "req-err-1",
    });

    const events: StreamEvent[] = [];
    const parts: Part[] = [{ type: "error", error: envelope }];

    const { assistantText } = await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    // No text event — the raw JSON must never reach the inline timeline.
    expect(collectEvents(events, "text")).toHaveLength(0);

    const errEvents = collectEvents(events, "error") as Extract<StreamEvent, { type: "error" }>[];
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]!.code).toBe("insufficient_credits");
    expect(errEvents[0]!.message).toBe(
      "Insufficient credits: your balance is empty. Please add credits to continue.",
    );
    expect(errEvents[0]!.message).not.toContain("{");
    expect(errEvents[0]!.messageId).toBe(BASE_ARGS.requestId);

    // The error is not folded into the persisted assistant reply.
    expect(assistantText).toBe("");
  });

  it("emits an `error` event with a plain message for a non-envelope error part", async () => {
    const events: StreamEvent[] = [];
    const parts: Part[] = [{ type: "error", error: "Gateway timeout" }];

    await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    const errEvents = collectEvents(events, "error") as Extract<StreamEvent, { type: "error" }>[];
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]!.message).toBe("Gateway timeout");
    expect(errEvents[0]!.code).toBeUndefined();
    expect(collectEvents(events, "text")).toHaveLength(0);
  });
});

describe("translateAgentStream — background-task lifecycle (OXA-1469)", () => {
  it("emits background-task-progress + persists a block when agent.task.background.start returns", async () => {
    const events: StreamEvent[] = [];
    const parts: Part[] = [
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "agent.task.background.start",
        input: { kind: "graph.ingest", label: "Ingest doc", payload: {} },
      },
      {
        type: "tool-result",
        toolCallId: "tc-1",
        output: { taskId: "task-99", inngestRunId: "run-77" },
      },
    ];

    const { persistedBlocks } = await translateAgentStream({
      ...BASE_ARGS,
      // toolName IS the capability when toolNameMap has no entry.
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    const bg = collectEvents(events, "background-task-progress") as Extract<
      StreamEvent,
      { type: "background-task-progress" }
    >[];
    expect(bg).toHaveLength(1);
    expect(bg[0]!.taskId).toBe("task-99");
    expect(bg[0]!.kind).toBe("graph.ingest");
    expect(bg[0]!.label).toBe("Ingest doc");
    expect(bg[0]!.status).toBe("pending");
    expect(bg[0]!.inngestRunId).toBe("run-77");

    // A terminal background-task block is persisted so the card survives refresh.
    const block = persistedBlocks.find((b) => b.type === "background-task");
    expect(block).toBeTruthy();
    expect(block).toMatchObject({ taskId: "task-99", kind: "graph.ingest", status: "pending" });
  });

  it("emits nothing when the start result has no taskId (graceful)", async () => {
    const events: StreamEvent[] = [];
    const parts: Part[] = [
      {
        type: "tool-call",
        toolCallId: "tc-2",
        toolName: "agent.task.background.start",
        input: { kind: "agent.task", payload: {} },
      },
      { type: "tool-result", toolCallId: "tc-2", output: {} },
    ];

    const { persistedBlocks } = await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    expect(collectEvents(events, "background-task-progress")).toHaveLength(0);
    expect(persistedBlocks.find((b) => b.type === "background-task")).toBeUndefined();
  });
});
