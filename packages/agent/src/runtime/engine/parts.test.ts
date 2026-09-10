/**
 * The engine's events, in the order the real binary emitted them for the
 * recorded turn, become the parts both chat translators read. The sequence
 * here is the golden transcript's event order, so a change in what the
 * engine emits shows up as a changed part list rather than as a blank chat.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@oxagen/stella-engine-client";
import { createPartMapper } from "./parts";

const ev = (e: Record<string, unknown>): AgentEvent =>
  e as unknown as AgentEvent;

const golden: AgentEvent[] = [
  ev({ type: "stage", name: "execute", scope: "run" }),
  ev({ type: "budget_tick", spent_usd: 0.001 }),
  ev({ type: "block_registered", block_id: "b1", kind: "user_goal" }),
  ev({
    type: "step_manifest",
    step: 0,
    model: "m",
    provider: "p",
    role: "worker",
    blocks: [],
  }),
  ev({
    type: "step_usage",
    step: 0,
    input_tokens: 10,
    output_tokens: 5,
    cached_input_tokens: 0,
    cost_usd: 0.001,
    duration_ms: 0,
    model: "m",
    retries: 0,
    tool_calls: 1,
  }),
  ev({
    type: "tool_start",
    call: { call_id: "call_1", name: "search_nodes", input: { q: "nodes" } },
  }),
  ev({
    type: "tool_result",
    call_id: "call_1",
    output: { ok: { content: "[n1,n2,n3]" } },
    duration_ms: 0,
    speculated: false,
  }),
  ev({ type: "text_delta", delta: "There are " }),
  ev({
    type: "step_manifest",
    step: 1,
    model: "m",
    provider: "p",
    role: "worker",
    blocks: [],
  }),
  ev({
    type: "step_usage",
    step: 1,
    input_tokens: 10,
    output_tokens: 5,
    cached_input_tokens: 2,
    cost_usd: 0.001,
    duration_ms: 0,
    model: "m",
    retries: 0,
    tool_calls: 0,
  }),
  ev({ type: "text", text: "There are 3 nodes." }),
  ev({ type: "stage", name: "complete", scope: "run" }),
  ev({ type: "turn_complete", model: "m", cost_usd: 0.002 }),
  ev({ type: "run_complete", model: "m", cost_usd: 0.002 }),
];

describe("createPartMapper", () => {
  it("maps the golden turn onto the translators' part vocabulary", () => {
    const mapper = createPartMapper();
    mapper.recordToolReturn(
      "search_nodes",
      { q: "nodes" },
      { rows: ["n1", "n2", "n3"] },
      false,
    );
    const parts = golden.flatMap((e) => mapper.map(e));
    parts.push(
      ...mapper.finish({
        status: "completed",
        text: "There are 3 nodes.",
        cost_usd: 0.002,
      }),
    );
    expect(parts.map((p) => p.type)).toEqual([
      "start-step",
      "tool-call",
      "tool-result",
      "text-delta",
      "finish-step",
      "finish",
    ]);
    const toolResult = parts.find((p) => p.type === "tool-result");
    // The host's own return value, not the engine's text rendering.
    expect(toolResult).toMatchObject({
      toolCallId: "call_1",
      toolName: "search_nodes",
      input: { q: "nodes" },
      output: { rows: ["n1", "n2", "n3"] },
    });
    expect(mapper.text).toBe("There are 3 nodes.");
    expect(mapper.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cachedInputTokens: 2,
    });
  });

  it("prefers the host's usage total on finish and keeps the engine's as a cross-check", () => {
    const mapper = createPartMapper();
    mapper.map(golden[4]!);
    const host = {
      inputTokens: 99,
      outputTokens: 1,
      totalTokens: 100,
      cachedInputTokens: 0,
    };
    const finish = mapper
      .finish({ status: "completed", text: "x", cost_usd: 0 }, host)
      .at(-1);
    expect(finish).toMatchObject({ type: "finish", totalUsage: host });
    expect(mapper.usage.inputTokens).toBe(10);
  });

  it("renders a failed tool as tool-error carrying the host's thrown error", () => {
    const mapper = createPartMapper();
    const boom = new Error("approval denied for delete_schema");
    mapper.recordToolReturn("delete_schema", { id: 1 }, undefined, true, boom);
    mapper.map(
      ev({
        type: "tool_start",
        call: { call_id: "c9", name: "delete_schema", input: { id: 1 } },
      }),
    );
    const [part] = mapper.map(
      ev({
        type: "tool_result",
        call_id: "c9",
        output: {
          error: {
            message: "approval denied for delete_schema",
            class: "refused_by_policy",
          },
        },
        duration_ms: 1,
      }),
    );
    expect(part).toMatchObject({
      type: "tool-error",
      toolCallId: "c9",
      toolName: "delete_schema",
      error: boom,
    });
  });

  it("joins two calls of the same tool with the same input to their returns in order", () => {
    const mapper = createPartMapper();
    mapper.recordToolReturn("t", { a: 1 }, "first", false);
    mapper.recordToolReturn("t", { a: 1 }, "second", false);
    mapper.map(
      ev({
        type: "tool_start",
        call: { call_id: "A", name: "t", input: { a: 1 } },
      }),
    );
    mapper.map(
      ev({
        type: "tool_start",
        call: { call_id: "B", name: "t", input: { a: 1 } },
      }),
    );
    const [a] = mapper.map(
      ev({
        type: "tool_result",
        call_id: "A",
        output: { ok: { content: "first" } },
        duration_ms: 0,
      }),
    );
    const [b] = mapper.map(
      ev({
        type: "tool_result",
        call_id: "B",
        output: { ok: { content: "second" } },
        duration_ms: 0,
      }),
    );
    expect(a).toMatchObject({ output: "first" });
    expect(b).toMatchObject({ output: "second" });
  });

  it("falls back to the engine's text when the host did not run the tool", () => {
    const mapper = createPartMapper();
    mapper.map(
      ev({ type: "tool_start", call: { call_id: "s1", name: "t", input: {} } }),
    );
    const [part] = mapper.map(
      ev({
        type: "tool_result",
        call_id: "s1",
        output: { ok: { content: "replayed" } },
        duration_ms: 0,
        speculated: true,
      }),
    );
    expect(part).toMatchObject({ type: "tool-result", output: "replayed" });
  });

  it("brackets reasoning with start and end, and ends it when text begins", () => {
    const mapper = createPartMapper();
    const parts = [
      ...mapper.map(ev({ type: "reasoning", delta: "hm" })),
      ...mapper.map(ev({ type: "reasoning", delta: "m" })),
      ...mapper.map(ev({ type: "text_delta", delta: "so" })),
    ];
    expect(parts.map((p) => p.type)).toEqual([
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-delta",
    ]);
  });

  it("turns an aborted outcome into an error part and an error finish", () => {
    const mapper = createPartMapper();
    const parts = mapper.finish({
      status: "aborted",
      reason: "loop detected",
      cost_usd: 0,
    });
    expect(parts.map((p) => p.type)).toEqual(["error", "finish"]);
    expect(parts[0]).toMatchObject({
      error: expect.objectContaining({
        message: "loop detected",
        code: "engine_aborted",
      }),
    });
    expect(parts[1]).toMatchObject({ finishReason: "error" });
  });

  it("passes an unknown event through as nothing", () => {
    const mapper = createPartMapper();
    expect(mapper.map(ev({ type: "future_event", x: 1 }))).toEqual([]);
  });
});
