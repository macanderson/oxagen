import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createApiStreamTranslator,
  type ApiStreamEvent,
} from "./chat-stream-translator";

// Byte-for-byte SSE wire snapshot for the REST chat stream (chat.stream.ts).
//
// The route was refactored to run through runCodingAgent (multi-step tool loop,
// invoke()-gated tools, per-turn memory recall, USD budget guard) instead of a
// single hand-rolled streamAgentReply. The client wire protocol MUST be
// byte-identical: the raw AI-SDK parts flow through THIS translator (the single
// source of truth for the part→SSE mapping) unchanged, so the emitted
// ApiStreamEvent sequence is exactly what the pre-engine transport produced.
//
// This test drives the translator with a representative single-step stream and
// locks the exact emitted events, then writes the on-the-wire SSE bytes to a
// verifications snapshot so any future drift in the mapping is caught.

const SNAPSHOT_DIR = join(
  __dirname,
  "../../../../../verifications/session_01WQkDajXjxLXveaPhWzsup7",
);

// A representative single-step turn: step boundary, reasoning, prose, a tool
// call with input streaming + result, then the terminal finish. This is exactly
// the AI-SDK fullStream shape a single streamAgentReply emitted before the
// engine unification (and what one engine step emits now).
const SCRIPTED_PARTS: unknown[] = [
  { type: "start-step" },
  { type: "reasoning-start", id: "r1" },
  { type: "reasoning-delta", id: "r1", text: "thinking" },
  { type: "reasoning-end", id: "r1" },
  { type: "text-delta", text: "Hello " },
  { type: "tool-input-start", id: "c1", toolName: "graph_query" },
  { type: "tool-input-delta", id: "c1", delta: '{"q":' },
  {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "graph_query",
    input: { q: "x" },
  },
  { type: "tool-result", toolCallId: "c1", output: { rows: 2 } },
  { type: "text-delta", text: "world" },
  {
    type: "finish",
    totalUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  },
  { type: "finish-step" },
];

const TOOL_NAME_MAP: Record<string, string> = { graph_query: "query_ontology" };

function drive(parts: unknown[]): {
  events: ApiStreamEvent[];
  execution: ReturnType<
    ReturnType<typeof createApiStreamTranslator>["finish"]
  >["execution"];
} {
  const events: ApiStreamEvent[] = [];
  const t = createApiStreamTranslator({
    toolNameMap: TOOL_NAME_MAP,
    emit: (e) => events.push(e),
  });
  for (const p of parts) t.onPart(p);
  const { execution } = t.finish();
  return { events, execution };
}

describe("createApiStreamTranslator — SSE wire parity", () => {
  it("maps AI-SDK parts to the exact ApiStreamEvent wire shapes (byte-for-byte)", () => {
    const { events } = drive(SCRIPTED_PARTS);

    // Strip nondeterministic durationMs so the shape/keys/ordering are asserted
    // exactly; durationMs presence is asserted separately below.
    const normalized = events.map((e) =>
      "durationMs" in e ? { ...e, durationMs: 0 } : e,
    );

    expect(normalized).toEqual([
      { type: "step-start", stepIndex: 0 },
      { type: "reasoning-start", reasoningId: "r1" },
      { type: "reasoning-delta", reasoningId: "r1", text: "thinking" },
      { type: "reasoning-end", reasoningId: "r1", durationMs: 0 },
      { type: "text", text: "Hello " },
      {
        type: "tool-input-start",
        toolCallId: "c1",
        capability: "query_ontology",
      },
      { type: "tool-input-delta", toolCallId: "c1", delta: '{"q":' },
      {
        type: "tool-call-start",
        toolCallId: "c1",
        capability: "query_ontology",
        inputPreview: { q: "x" },
        riskLevel: "low",
      },
      {
        type: "tool-call-end",
        toolCallId: "c1",
        status: "completed",
        output: { rows: 2 },
        durationMs: 0,
      },
      { type: "text", text: "world" },
      { type: "step-finish", stepIndex: 0 },
    ]);

    // The translator does NOT emit `usage` (the route emits ONE aggregated usage
    // from result.usage after the loop) — assert no usage event slipped in here.
    expect(events.find((e) => e.type === "usage")).toBeUndefined();
  });

  it("collects per-step execution metadata (tokens from finish, tool calls per step)", () => {
    const { execution } = drive(SCRIPTED_PARTS);
    expect(execution.inputTokens).toBe(11);
    expect(execution.outputTokens).toBe(7);
    expect(execution.steps).toHaveLength(1);
    const step = execution.steps[0]!;
    expect(step.stepNumber).toBe(0);
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolCalls[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "graph_query",
      status: "completed",
      output: { rows: 2 },
    });
  });

  it("maps a tool-error part to a failed tool-call-end", () => {
    const events: ApiStreamEvent[] = [];
    const t = createApiStreamTranslator({
      toolNameMap: TOOL_NAME_MAP,
      emit: (e) => events.push(e),
    });
    t.onPart({ type: "start-step" });
    t.onPart({
      type: "tool-call",
      toolCallId: "c9",
      toolName: "graph_query",
      input: {},
    });
    t.onPart({
      type: "tool-error",
      toolCallId: "c9",
      error: new Error("boom"),
    });
    const end = events.find((e) => e.type === "tool-call-end");
    expect(end).toMatchObject({
      type: "tool-call-end",
      toolCallId: "c9",
      status: "failed",
      errorReason: "boom",
    });
  });

  it("surfaces a defensive error part as a typed error event", () => {
    const events: ApiStreamEvent[] = [];
    const t = createApiStreamTranslator({
      toolNameMap: {},
      emit: (e) => events.push(e),
    });
    t.onPart({ type: "error", error: "rate limited" });
    const { streamErrored } = t.finish();
    expect(streamErrored).toBe(true);
    expect(events).toContainEqual({ type: "error", message: "rate limited" });
  });

  it("writes the on-the-wire SSE snapshot artifact", () => {
    const { events } = drive(SCRIPTED_PARTS);
    // Reproduce the route's exact framing: `data: <JSON>\n\n` per event, then the
    // ONE aggregated usage event (route emits from result.usage), then the
    // terminal `event: done` sentinel.
    const usageEvent: ApiStreamEvent = {
      type: "usage",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    };
    const wire =
      [...events, usageEvent]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("") + "event: done\ndata: [DONE]\n\n";

    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(
      join(SNAPSHOT_DIR, "api-chat-sse-snapshot.txt"),
      wire,
      "utf8",
    );

    // Lock the frame shape: every event line is `data: {...}` and the stream
    // terminates with the `[DONE]` sentinel.
    expect(wire.endsWith("event: done\ndata: [DONE]\n\n")).toBe(true);
    expect(wire.startsWith('data: {"type":"step-start"')).toBe(true);
  });
});
