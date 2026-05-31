import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerFromModelId: vi.fn(),
  defaultModel: vi.fn(),
}));

// "streamText" returns an object that has the stream shape; tests call
// onFinish manually to exercise the telemetry path without a real LLM.
mocks.streamText.mockImplementation((args: { onFinish: (...a: unknown[]) => unknown }) => ({
  _onFinish: args.onFinish,
}));
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("aabbccdd");
mocks.providerFromModelId.mockReturnValue("anthropic");
mocks.defaultModel.mockReturnValue({ modelId: "claude-sonnet-4-6" });

vi.mock("ai", () => ({ streamText: mocks.streamText }));
vi.mock("@oxagen/telemetry", () => ({
  hashPrompt: mocks.hashPrompt,
  insertTokenUsage: mocks.insertTokenUsage,
  providerFromModelId: mocks.providerFromModelId,
}));
vi.mock("./models.js", () => ({ defaultModel: mocks.defaultModel }));

import { streamAgentReply } from "./stream.js";

// ─────────────────────────────────────────────────────────────────────────────

type StreamResult = ReturnType<typeof streamAgentReply> & {
  _onFinish: (event: {
    text: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason: string;
  }) => Promise<void>;
};

const TELEMETRY = {
  orgId: "org_1",
  workspaceId: "ws_1",
  surface: "api" as const,
  messageId: "msg_abc",
};

const MESSAGES = [
  { role: "user" as const, content: "hello" },
];

const USAGE_EVENT = {
  text: "hi there",
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  finishReason: "stop",
};

beforeEach(() => {
  mocks.streamText.mockClear();
  mocks.insertTokenUsage.mockClear();
  mocks.hashPrompt.mockClear();
  mocks.providerFromModelId.mockClear();
  // restore defaults
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.hashPrompt.mockResolvedValue("aabbccdd");
  mocks.providerFromModelId.mockReturnValue("anthropic");
});

describe("streamAgentReply telemetry (@oxagen/ai)", () => {
  it("calls streamText with the supplied messages and default temperature", () => {
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.messages).toBe(MESSAGES);
    expect(arg.temperature).toBe(0.7);
  });

  it("uses defaultModel() when no model arg is given", () => {
    const before = mocks.defaultModel.mock.calls.length;
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY });
    const after = mocks.defaultModel.mock.calls.length;
    expect(after - before).toBe(1);
  });

  it("uses the caller-supplied model when provided, never calls defaultModel", () => {
    const customModel = { modelId: "claude-3-haiku-20240307" };
    const before = mocks.defaultModel.mock.calls.length;
    // Cast needed because LanguageModel has more methods; modelId is what we test.
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY, model: customModel as Parameters<typeof streamAgentReply>[0]["model"] });
    const after = mocks.defaultModel.mock.calls.length;
    // defaultModel must NOT have been invoked by this call
    expect(after - before).toBe(0);
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((arg.model as { modelId: string }).modelId).toBe("claude-3-haiku-20240307");
  });

  it("onFinish writes a token_usage row with correct telemetry fields", async () => {
    const result = streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY }) as StreamResult;
    await result._onFinish(USAGE_EVENT);

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("org_1");
    expect(row.workspace_id).toBe("ws_1");
    expect(row.surface).toBe("api");
    expect(row.execution_step_id).toBe("msg_abc");
    expect(row.input_tokens).toBe(10);
    expect(row.output_tokens).toBe(20);
    expect(row.cost_usd_micros).toBe(0);
    expect(typeof row.duration_ms).toBe("number");
  });

  it("onFinish hashes the last user message content", async () => {
    const result = streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY }) as StreamResult;
    await result._onFinish(USAGE_EVENT);
    expect(mocks.hashPrompt).toHaveBeenCalledWith("hello");
  });

  it("hashes stringified content when the last user message content is not a plain string", async () => {
    const structuredMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "structured" }] },
    ];
    const result = streamAgentReply({ messages: structuredMessages, telemetry: TELEMETRY }) as StreamResult;
    await result._onFinish(USAGE_EVENT);
    expect(mocks.hashPrompt).toHaveBeenCalledWith(
      JSON.stringify([{ type: "text", text: "structured" }]),
    );
  });

  it("swallows a ClickHouse insertTokenUsage error and still calls onFinish", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("CH down"));
    let calledOnFinish = false;
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      onFinish: async () => {
        calledOnFinish = true;
      },
    }) as StreamResult;
    // Should not throw
    await result._onFinish(USAGE_EVENT);
    expect(calledOnFinish).toBe(true);
  });

  it("swallows a hashPrompt error and still calls onFinish", async () => {
    mocks.hashPrompt.mockRejectedValueOnce(new Error("hash failure"));
    let calledOnFinish = false;
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      onFinish: async () => {
        calledOnFinish = true;
      },
    }) as StreamResult;
    await result._onFinish(USAGE_EVENT);
    expect(calledOnFinish).toBe(true);
  });

  it("forwards text, usage and finishReason to the caller-supplied onFinish", async () => {
    let captured: Record<string, unknown> | null = null;
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      onFinish: async (e) => {
        captured = e as Record<string, unknown>;
      },
    }) as StreamResult;
    await result._onFinish(USAGE_EVENT);
    expect(captured).not.toBeNull();
    expect(captured!.text).toBe("hi there");
    expect((captured!.usage as Record<string, number>).promptTokens).toBe(10);
    expect(captured!.finishReason).toBe("stop");
  });

  it("resolves promptTokens/completionTokens to 0 when usage fields are missing", async () => {
    const result = streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY }) as StreamResult;
    await result._onFinish({
      text: "",
      usage: { promptTokens: undefined as unknown as number, completionTokens: undefined as unknown as number, totalTokens: 0 },
      finishReason: "stop",
    });
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    const row = rows[0] as Record<string, unknown>;
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });
});
