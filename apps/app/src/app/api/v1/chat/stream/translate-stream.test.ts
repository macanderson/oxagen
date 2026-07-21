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

import {
  translateAgentStream,
  createTurnTranslator,
  emitUsageEvent,
} from "./translate-stream";
import type { StreamEvent } from "@/components/chat/stream-event-types";
import { meterCreditsForUsage } from "@oxagen/billing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Part =
  | { type: "text-delta"; text: string }
  | {
      type: "finish";
      totalUsage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }
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
      {
        type: "finish",
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    ];

    await translateAgentStream({
      ...BASE_ARGS,
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    const usageEvents = collectEvents(events, "usage");
    expect(usageEvents).toHaveLength(1);
    const usageEvent = usageEvents[0] as Extract<
      StreamEvent,
      { type: "usage" }
    >;
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
      {
        type: "finish",
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ];

    await translateAgentStream({
      ...BASE_ARGS,
      modelId: "bogus/model",
      fullStream: makeStream(parts),
      emit: (e) => events.push(e),
    });

    const usageEvents = collectEvents(events, "usage");
    expect(usageEvents).toHaveLength(1);
    const usageEvent = usageEvents[0] as Extract<
      StreamEvent,
      { type: "usage" }
    >;
    expect(usageEvent.usage.totalTokens).toBe(15);
    // creditsCharged must be absent (not set to 0 or NaN)
    expect(usageEvent.usage.creditsCharged).toBeUndefined();
  });

  it("(c) emits no usage event when the stream ends without a finish part", async () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(0n);

    const events: StreamEvent[] = [];
    const parts: Part[] = [{ type: "error", error: "Gateway timeout" }];

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
      {
        type: "finish",
        totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
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
        message:
          "Insufficient credits: your balance is empty. Please add credits to continue.",
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

    const errEvents = collectEvents(events, "error") as Extract<
      StreamEvent,
      { type: "error" }
    >[];
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

    const errEvents = collectEvents(events, "error") as Extract<
      StreamEvent,
      { type: "error" }
    >[];
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
        toolName: "start_background_task",
        input: { kind: "index_document", label: "Index doc", payload: {} },
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
    expect(bg[0]!.kind).toBe("index_document");
    expect(bg[0]!.label).toBe("Index doc");
    expect(bg[0]!.status).toBe("pending");
    expect(bg[0]!.inngestRunId).toBe("run-77");

    // A terminal background-task block is persisted so the card survives refresh.
    const block = persistedBlocks.find((b) => b.type === "background-task");
    expect(block).toBeTruthy();
    expect(block).toMatchObject({
      taskId: "task-99",
      kind: "index_document",
      status: "pending",
    });
  });

  it("emits nothing when the start result has no taskId (graceful)", async () => {
    const events: StreamEvent[] = [];
    const parts: Part[] = [
      {
        type: "tool-call",
        toolCallId: "tc-2",
        toolName: "start_background_task",
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
    expect(
      persistedBlocks.find((b) => b.type === "background-task"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTurnTranslator — stateful engine path (agent-engine unification)
// ---------------------------------------------------------------------------

const TRANSLATOR_ARGS = {
  requestId: "req-1",
  toolNameMap: {} as Record<string, string>,
  orgSlug: "my-org",
  workspaceSlug: "my-ws",
};

/** Drive a raw part sequence through a fresh stateful translator. */
function runTranslator(parts: unknown[]): {
  events: StreamEvent[];
  turn: ReturnType<ReturnType<typeof createTurnTranslator>["finish"]>;
} {
  const events: StreamEvent[] = [];
  const translator = createTurnTranslator({
    ...TRANSLATOR_ARGS,
    emit: (e) => events.push(e),
  });
  for (const p of parts) translator.onPart(p);
  return { events, turn: translator.finish() };
}

describe("createTurnTranslator — reasoning-id namespacing across steps (C2)", () => {
  beforeEach(() => {
    vi.mocked(meterCreditsForUsage).mockReset();
  });

  it("namespaces per-step colliding reasoning ids so cards never clobber each other", () => {
    // The engine drives one streamText per step, so reasoning `id` can REPEAT
    // across steps ("r" here). Two steps, both using id "r".
    const parts: unknown[] = [
      { type: "start-step" },
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", text: "first-thought" },
      { type: "reasoning-end", id: "r" },
      { type: "text-delta", text: "one" },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", text: "second-thought" },
      { type: "reasoning-end", id: "r" },
      { type: "text-delta", text: "two" },
      { type: "finish-step" },
    ];

    const { events, turn } = runTranslator(parts);

    // Two distinct, step-namespaced reasoning ids reach the client.
    const starts = events.filter(
      (e) => e.type === "reasoning-start",
    ) as Extract<StreamEvent, { type: "reasoning-start" }>[];
    expect(starts.map((e) => e.reasoningId)).toEqual(["s0:r", "s1:r"]);

    // Deltas route to the right namespaced card.
    const deltas = events.filter(
      (e) => e.type === "reasoning-delta",
    ) as Extract<StreamEvent, { type: "reasoning-delta" }>[];
    expect(deltas).toEqual([
      { type: "reasoning-delta", reasoningId: "s0:r", text: "first-thought" },
      { type: "reasoning-delta", reasoningId: "s1:r", text: "second-thought" },
    ]);

    // Both reasoning cards survive with their OWN text — the second did not
    // overwrite the first (the bug namespacing prevents).
    const reasoningBlocks = turn.persistedBlocks.filter(
      (b) => b.type === "reasoning",
    ) as Array<{
      type: "reasoning";
      reasoningId: string;
      text: string;
    }>;
    expect(reasoningBlocks).toHaveLength(2);
    expect(reasoningBlocks[0]).toMatchObject({
      reasoningId: "s0:r",
      text: "first-thought",
    });
    expect(reasoningBlocks[1]).toMatchObject({
      reasoningId: "s1:r",
      text: "second-thought",
    });

    // Text from both steps accumulates in order.
    expect(turn.assistantText).toBe("onetwo");
  });

  it("does NOT namespace tool call ids (provider ids are already unique)", () => {
    const parts: unknown[] = [
      { type: "start-step" },
      {
        type: "tool-call",
        toolCallId: "toolu_abc",
        toolName: "get_graph_stats",
        input: {},
      },
      { type: "tool-result", toolCallId: "toolu_abc", output: { ok: true } },
      { type: "finish-step" },
    ];
    const { events } = runTranslator(parts);
    const start = events.find((e) => e.type === "tool-call-start") as Extract<
      StreamEvent,
      { type: "tool-call-start" }
    >;
    const end = events.find((e) => e.type === "tool-call-end") as Extract<
      StreamEvent,
      { type: "tool-call-end" }
    >;
    // Raw provider id passes through verbatim — no s{n}: prefix.
    expect(start.toolCallId).toBe("toolu_abc");
    expect(end.toolCallId).toBe("toolu_abc");
  });

  it("skips preliminary tool-result parts (no premature tool-call-end)", () => {
    const parts: unknown[] = [
      { type: "start-step" },
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "get_graph_stats",
        input: {},
      },
      // Streamed partial output — must be ignored.
      {
        type: "tool-result",
        toolCallId: "tc-1",
        output: { partial: true },
        preliminary: true,
      },
      { type: "tool-result", toolCallId: "tc-1", output: { ok: true } },
      { type: "finish-step" },
    ];
    const { events } = runTranslator(parts);
    const ends = events.filter((e) => e.type === "tool-call-end");
    // Exactly one terminal event — the preliminary result did not produce one.
    expect(ends).toHaveLength(1);
  });

  it("onPart suppresses finish and error — the caller owns usage + error", () => {
    const parts: unknown[] = [
      { type: "text-delta", text: "hi" },
      {
        type: "finish",
        totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      { type: "error", error: "boom" },
    ];
    const { events } = runTranslator(parts);
    expect(collectEvents(events, "usage")).toHaveLength(0);
    expect(collectEvents(events, "error")).toHaveLength(0);
    // Text still flowed.
    expect(collectEvents(events, "text")).toHaveLength(1);
  });
});

describe("createTurnTranslator — parity with the single-pass wrapper", () => {
  beforeEach(() => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(7n);
  });

  it("stateful step-by-step drive == single-pass translateAgentStream (minus usage/error position)", async () => {
    // A non-colliding sequence: the two paths must emit identical events for
    // everything except finish/error (which the engine caller emits itself).
    const parts: unknown[] = [
      { type: "start-step" },
      { type: "reasoning-start", id: "a" },
      { type: "reasoning-delta", id: "a", text: "think" },
      { type: "reasoning-end", id: "a" },
      { type: "text-delta", text: "answer " },
      {
        type: "tool-call",
        toolCallId: "toolu_1",
        toolName: "get_graph_stats",
        input: { q: 1 },
      },
      { type: "tool-result", toolCallId: "toolu_1", output: { count: 3 } },
      { type: "text-delta", text: "done" },
      { type: "finish-step" },
    ];

    // Single-pass wrapper.
    const wrapperEvents: StreamEvent[] = [];
    const wrapperTurn = await translateAgentStream({
      ...TRANSLATOR_ARGS,
      modelId: "anthropic/claude-sonnet-5",
      fullStream: (async function* () {
        for (const p of parts) yield p;
      })(),
      emit: (e) => wrapperEvents.push(e),
    });

    // Stateful engine path.
    const { events: statefulEvents, turn: statefulTurn } = runTranslator(parts);

    // The wrapper adds NO usage/error here (no finish/error parts present), so
    // the two event streams must be byte-identical.
    expect(statefulEvents).toEqual(wrapperEvents);
    expect(statefulTurn.assistantText).toBe(wrapperTurn.assistantText);
    expect(statefulTurn.persistedBlocks).toEqual(wrapperTurn.persistedBlocks);
    expect(statefulTurn.assistantText).toBe("answer done");
  });
});

describe("emitUsageEvent", () => {
  beforeEach(() => {
    vi.mocked(meterCreditsForUsage).mockReset();
  });

  it("emits one usage event with creditsCharged from the aggregated turn usage", () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(99n);
    const events: StreamEvent[] = [];
    emitUsageEvent(
      (e) => events.push(e),
      { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      "anthropic/claude-sonnet-5",
    );
    expect(events).toHaveLength(1);
    const usage = events[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usage.usage).toEqual({
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
      creditsCharged: 99,
    });
    expect(vi.mocked(meterCreditsForUsage)).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-5",
      inputTokens: 200,
      outputTokens: 80,
    });
  });

  it("forwards cachedTokens (prompt-cache reads) when present, clamped to the prompt", () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(10n);
    const events: StreamEvent[] = [];
    emitUsageEvent(
      (e) => events.push(e),
      {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        cachedInputTokens: 800,
      },
      "anthropic/claude-sonnet-5",
    );
    const usage = events[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usage.usage.cachedTokens).toBe(800);
  });

  it("clamps cachedTokens to the prompt size when the provider over-reports", () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(10n);
    const events: StreamEvent[] = [];
    emitUsageEvent(
      (e) => events.push(e),
      {
        inputTokens: 500,
        outputTokens: 0,
        totalTokens: 500,
        cachedInputTokens: 900,
      },
      "x/y",
    );
    const usage = events[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usage.usage.cachedTokens).toBe(500);
  });

  it("omits cachedTokens entirely when there were no cache hits", () => {
    vi.mocked(meterCreditsForUsage).mockReturnValue(10n);
    const events: StreamEvent[] = [];
    emitUsageEvent(
      (e) => events.push(e),
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 0,
      },
      "x/y",
    );
    const usage = events[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usage.usage.cachedTokens).toBeUndefined();
  });

  it("omits creditsCharged when the meter throws (unknown model)", () => {
    vi.mocked(meterCreditsForUsage).mockImplementation(() => {
      throw new Error("unknown model");
    });
    const events: StreamEvent[] = [];
    emitUsageEvent(
      (e) => events.push(e),
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      "x/y",
    );
    const usage = events[0] as Extract<StreamEvent, { type: "usage" }>;
    expect(usage.usage.creditsCharged).toBeUndefined();
    expect(usage.usage.totalTokens).toBe(2);
  });
});
