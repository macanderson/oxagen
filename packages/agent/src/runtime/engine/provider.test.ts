import { beforeEach, describe, expect, it, vi } from "vitest";

const streamAgentReply = vi.fn();
const selectModel = vi.fn((s: { tier?: string }) => ({
  modelId: `model-for-${s.tier}`,
}));
vi.mock("@oxagen/ai", () => ({
  streamAgentReply: (args: unknown) => streamAgentReply(args),
  selectModel: (s: { tier?: string }) => selectModel(s),
  modelIdOf: (m: unknown) =>
    typeof m === "string" ? m : ((m as { modelId?: string }).modelId ?? ""),
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));

import {
  createProviderPort,
  splitSystem,
  toCompletionUsage,
  toEngineFinishReason,
} from "./provider";

function stream(o: {
  text?: string;
  deltas?: string[];
  reasoning?: string[];
  toolCalls?: unknown[];
  usage?: unknown;
  finish?: string;
}) {
  return {
    fullStream: (async function* () {
      for (const t of o.reasoning ?? [])
        yield { type: "reasoning-delta", id: "r", text: t };
      for (const t of o.deltas ?? [])
        yield { type: "text-delta", id: "t", text: t };
    })(),
    text: Promise.resolve(o.text ?? ""),
    toolCalls: Promise.resolve(o.toolCalls ?? []),
    usage: Promise.resolve(o.usage ?? { inputTokens: 3, outputTokens: 2 }),
    finishReason: Promise.resolve(o.finish ?? "stop"),
  };
}

const telemetry = {
  orgId: "o",
  workspaceId: "w",
  surface: "app" as const,
  messageId: "m",
};

describe("createProviderPort", () => {
  beforeEach(() => {
    streamAgentReply.mockReset();
    selectModel.mockClear();
  });

  it("answers a worker request through the chokepoint with one step, deltas, usage and cost", async () => {
    streamAgentReply.mockImplementation(() =>
      stream({
        text: "hello",
        deltas: ["hel", "lo"],
        reasoning: ["think"],
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          inputTokenDetails: { cacheReadTokens: 20 },
        },
      }),
    );
    const onUsage = vi.fn();
    const port = createProviderPort({
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      workerTier: "balanced",
      system: "SYS",
      tools: { t: { description: "d" } } as never,
      telemetry,
      fundedBy: "platform",
      effort: "high",
      onUsage,
    });
    const deltas = vi.fn(async () => undefined);
    const result = await port(
      {
        request_id: "prov-1-0",
        provider_id: "oxagen",
        role: "worker",
        request: {
          messages: [
            { role: "system", content: "SYS from engine" },
            { role: "user", content: "hi" },
          ],
          max_output_tokens: 4096,
        },
      },
      { signal: new AbortController().signal, deltas },
    );

    const args = streamAgentReply.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.system).toBe("SYS from engine");
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(args.stopWhen).toEqual({ __stepCountIs: 1 });
    expect(args.fundedBy).toBe("platform");
    expect(args.chargeReason).toBe("consume_assistant_tokens");
    expect(args.effort).toBe("high");
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.model).toEqual({ modelId: "anthropic/claude-sonnet-4.6" });

    expect(deltas).toHaveBeenCalledWith([
      { kind: "reasoning", text: "think" },
      { kind: "text", text: "hel" },
      { kind: "text", text: "lo" },
    ]);
    expect(result).toMatchObject({
      text: "hello",
      tool_calls: [],
      model: "anthropic/claude-sonnet-4.6",
      finish_reason: "stop",
      usage: {
        reported: true,
        input_tokens: 100,
        output_tokens: 10,
        cached_input_tokens: 20,
        cache_write_tokens: 0,
      },
    });
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(onUsage).toHaveBeenCalledWith(
      result.usage,
      "anthropic/claude-sonnet-4.6",
    );
  });

  it("returns the model's tool calls without running them, as tool_calls with the engine's spelling", async () => {
    streamAgentReply.mockImplementation(() =>
      stream({
        toolCalls: [{ toolCallId: "c1", toolName: "search", input: { q: 1 } }],
        finish: "tool-calls",
      }),
    );
    const port = createProviderPort({
      model: { modelId: "m" } as never,
      workerTier: "balanced",
      system: "S",
      tools: {},
      telemetry,
      fundedBy: "org",
    });
    const result = await port(
      {
        request_id: "r",
        provider_id: "oxagen",
        role: "worker",
        request: { messages: [{ role: "user", content: "q" }] },
      },
      { signal: new AbortController().signal, deltas: async () => undefined },
    );
    expect(result.tool_calls).toEqual([
      { call_id: "c1", name: "search", input: { q: 1 } },
    ]);
    expect(result.finish_reason).toBe("tool_calls");
    expect(
      (streamAgentReply.mock.calls[0]![0] as Record<string, unknown>).fundedBy,
    ).toBe("org");
  });

  it("answers a verdict request on a different tier than the worker", async () => {
    streamAgentReply.mockImplementation(() => stream({ text: "PASS" }));
    const port = createProviderPort({
      model: { modelId: "worker-model" } as never,
      workerTier: "balanced",
      system: "S",
      tools: {},
      telemetry,
      fundedBy: "platform",
    });
    const result = await port(
      {
        request_id: "r",
        provider_id: "oxagen",
        role: "verdict",
        request: { messages: [{ role: "user", content: "judge" }] },
      },
      { signal: new AbortController().signal, deltas: async () => undefined },
    );
    expect(selectModel).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "precise" }),
    );
    expect(result.model).toBe("model-for-precise");
  });
});

describe("helpers", () => {
  it("hoists only the leading system messages", () => {
    const { system, messages } = splitSystem(
      [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "user", content: "u" },
        { role: "system", content: "steer" },
      ],
      "fallback",
    );
    expect(system).toBe("a\n\nb");
    expect(messages).toEqual([
      { role: "user", content: "u" },
      { role: "system", content: "steer" },
    ]);
    expect(
      splitSystem([{ role: "user", content: "u" }], "fallback").system,
    ).toBe("fallback");
  });

  it("normalises usage and finish reasons into the engine's spellings", () => {
    expect(toCompletionUsage({})).toEqual({
      reported: true,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(toEngineFinishReason("tool-calls")).toBe("tool_calls");
    expect(toEngineFinishReason("length")).toBe("length");
    expect(toEngineFinishReason("content-filter")).toBe("content_filter");
    expect(toEngineFinishReason("other")).toBe("stop");
  });
});
