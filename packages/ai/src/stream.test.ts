import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerFromModelId: vi.fn(),
  defaultModel: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
}));

// "streamText" returns an object that has the stream shape; tests call
// onFinish manually to exercise the telemetry path without a real LLM.
mocks.streamText.mockImplementation(
  (args: { onFinish: (...a: unknown[]) => unknown }) => ({
    _onFinish: args.onFinish,
  }),
);
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("aabbccdd");
mocks.providerFromModelId.mockReturnValue("anthropic");
mocks.defaultModel.mockReturnValue({ modelId: "claude-sonnet-5" });
// 10 input @ $3/1M + 20 output @ $15/1M = 330 micro-USD for USAGE_EVENT.
mocks.providerCostUsdMicros.mockReturnValue(330);
mocks.chargeUsageCredits.mockResolvedValue({
  costUsdMicros: 330,
  creditsMetered: 1n,
  creditsCharged: 1n,
  shortfallCredits: 0n,
});

vi.mock("ai", () => ({ streamText: mocks.streamText }));
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    hashPrompt: mocks.hashPrompt,
    insertTokenUsage: mocks.insertTokenUsage,
    providerFromModelId: mocks.providerFromModelId,
  };
});
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    providerCostUsdMicros: mocks.providerCostUsdMicros,
    chargeUsageCredits: mocks.chargeUsageCredits,
  };
});
vi.mock("./models", () => ({
  defaultModel: mocks.defaultModel,
  modelIdOf: (m: { modelId: string } | string) =>
    typeof m === "string" ? m : m.modelId,
}));

import { streamAgentReply, reasoningRequestConfig } from "./stream";

// ─────────────────────────────────────────────────────────────────────────────

type StreamResult = ReturnType<typeof streamAgentReply> & {
  _onFinish: (event: {
    text: string;
    totalUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    };
    finishReason: string;
  }) => Promise<void>;
};

const TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "api" as const,
  messageId: "msg_abc",
};

const MESSAGES = [{ role: "user" as const, content: "hello" }];

const USAGE_EVENT = {
  text: "hi there",
  totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  finishReason: "stop",
};

beforeEach(() => {
  mocks.streamText.mockClear();
  mocks.insertTokenUsage.mockClear();
  mocks.hashPrompt.mockClear();
  mocks.providerFromModelId.mockClear();
  mocks.providerCostUsdMicros.mockClear();
  mocks.chargeUsageCredits.mockClear();
  // restore defaults
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.hashPrompt.mockResolvedValue("aabbccdd");
  mocks.providerFromModelId.mockReturnValue("anthropic");
  mocks.providerCostUsdMicros.mockReturnValue(330);
  mocks.chargeUsageCredits.mockResolvedValue({
    costUsdMicros: 330,
    creditsMetered: 1n,
    creditsCharged: 1n,
    shortfallCredits: 0n,
  });
});

describe("streamAgentReply telemetry (@oxagen/ai)", () => {
  it("calls streamText with the supplied messages and default temperature", () => {
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    // No system supplied → no cached system message prepended; messages pass through.
    expect(arg.messages).toEqual(MESSAGES);
    expect(arg.temperature).toBe(0.7);
  });

  it("forwards abortSignal verbatim to streamText when supplied", () => {
    const controller = new AbortController();
    streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      abortSignal: controller.signal,
    });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.abortSignal).toBe(controller.signal);
  });

  it("omits abortSignal when not supplied (SDK default: no cancellation)", () => {
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("abortSignal" in arg).toBe(false);
  });

  it("forwards maxRetries verbatim (0 = outer system owns retries, e.g. the engine loop)", () => {
    streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      maxRetries: 0,
    });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.maxRetries).toBe(0);
  });

  it("omits maxRetries when not supplied (SDK default stays for retry-less surfaces)", () => {
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("maxRetries" in arg).toBe(false);
  });

  it("prepends the system prompt as an Anthropic-cacheable system message", () => {
    streamAgentReply({
      messages: MESSAGES,
      system: "You are Oxagen.",
      telemetry: TELEMETRY,
    });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    // AI SDK v7 rejects system-role entries in `messages` unless this flag is
    // set — without it every platform-routed turn fails with "Invalid prompt:
    // System messages are not allowed in the prompt or messages fields".
    expect(arg.allowSystemInMessages).toBe(true);
    const msgs = arg.messages as Array<Record<string, unknown>>;
    // Leading system message carries the ephemeral cache_control breakpoint;
    // the `system` param is NOT used (only message-level providerOptions can
    // place a cache marker).
    expect(arg.system).toBeUndefined();
    expect(msgs[0]).toEqual({
      role: "system",
      content: "You are Oxagen.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(msgs.slice(1)).toEqual(MESSAGES);
  });

  it("does not set providerOptions when no effort is supplied", () => {
    streamAgentReply({ messages: MESSAGES, telemetry: TELEMETRY });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.providerOptions).toBeUndefined();
  });

  it("falls back to the openai namespace for a model id without a vendor prefix", () => {
    // defaultModel() returns { modelId: "claude-sonnet-5" } (no "/" prefix)
    // which lands in the default/back-compat branch.
    streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      effort: "high",
    });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
    // default branch does NOT lock temperature
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
    streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      model: customModel as Parameters<typeof streamAgentReply>[0]["model"],
    });
    const after = mocks.defaultModel.mock.calls.length;
    // defaultModel must NOT have been invoked by this call
    expect(after - before).toBe(0);
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((arg.model as { modelId: string }).modelId).toBe(
      "claude-3-haiku-20240307",
    );
  });

  it("onFinish writes a token_usage row with correct telemetry fields", async () => {
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
    }) as StreamResult;
    await result._onFinish(USAGE_EVENT);

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(row.workspace_id).toBe("00000000-0000-4000-8000-000000000002");
    expect(row.surface).toBe("api");
    expect(row.execution_step_id).toBe("msg_abc");
    expect(row.input_tokens).toBe(10);
    expect(row.output_tokens).toBe(20);
    // The gate now prices the call through the cost meter rather than writing 0.
    expect(row.cost_usd_micros).toBe(330);
    expect(typeof row.duration_ms).toBe("number");
  });

  it("onFinish charges the org's credits through the gate meter", async () => {
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
    }) as StreamResult;
    await result._onFinish(USAGE_EVENT);

    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000001",
      referenceId: "msg_abc",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("forwards prompt-cache reads (inputTokenDetails.cacheReadTokens) to telemetry and the meter", async () => {
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
    }) as StreamResult;
    await result._onFinish({
      text: "hi there",
      totalUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputTokenDetails: { cacheReadTokens: 80 },
      },
      finishReason: "stop",
    });
    // Telemetry row records the real cached count (not hardcoded 0).
    const rows = (
      mocks.insertTokenUsage.mock.calls[0] as [Array<Record<string, unknown>>]
    )[0];
    expect(rows[0]?.cached_tokens).toBe(80);
    // The meter receives cachedTokens so the cached portion is priced cheaper.
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedTokens: 80,
        inputTokens: 100,
        outputTokens: 20,
      }),
    );
  });

  it("forwards prompt-cache writes (inputTokenDetails.cacheWriteTokens) to telemetry and the meter (#1076)", async () => {
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
    }) as StreamResult;
    await result._onFinish({
      text: "hi there",
      totalUsage: {
        // Flat inputTokens is the INCLUSIVE total (fresh + reads + writes) — the
        // AI SDK v7 gateway convention. Here 40 fresh + 30 read + 30 write.
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 30 },
      },
      finishReason: "stop",
    });
    // Telemetry row records the fourth token class so the billing rollup can
    // price cache writes at the provider premium instead of as fresh input.
    const rows = (
      mocks.insertTokenUsage.mock.calls[0] as [Array<Record<string, unknown>>]
    )[0];
    expect(rows[0]?.cache_write_tokens).toBe(30);
    expect(rows[0]?.cached_tokens).toBe(30);
    // The meter receives cacheWriteTokens so it prices the write portion at the
    // premium rate (Anthropic 1.25x base input), not fresh 1x input.
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 100,
        cachedTokens: 30,
        cacheWriteTokens: 30,
      }),
    );
  });

  it("swallows a credit-charge error and still calls onFinish", async () => {
    mocks.chargeUsageCredits.mockRejectedValueOnce(new Error("billing down"));
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

  it("onFinish hashes the last user message content", async () => {
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
    }) as StreamResult;
    await result._onFinish(USAGE_EVENT);
    expect(mocks.hashPrompt).toHaveBeenCalledWith("hello");
  });

  it("hashes stringified content when the last user message content is not a plain string", async () => {
    const structuredMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "structured" }],
      },
    ];
    const result = streamAgentReply({
      messages: structuredMessages,
      telemetry: TELEMETRY,
    }) as StreamResult;
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
    const result = streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
    }) as StreamResult;
    await result._onFinish({
      text: "",
      totalUsage: {
        inputTokens: undefined as unknown as number,
        outputTokens: undefined as unknown as number,
        totalTokens: 0,
      },
      finishReason: "stop",
    });
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    const row = rows[0] as Record<string, unknown>;
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });

  it("omits temperature entirely when an anthropic-prefixed model is used with effort", () => {
    // Override the modelIdOf mock to return a prefixed id so the anthropic
    // branch fires and temperatureLocked = true.
    const anthropicModel = { modelId: "anthropic/claude-opus-4.8" };
    streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      effort: "medium",
      model: anthropicModel as Parameters<typeof streamAgentReply>[0]["model"],
    });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    // temperature must be absent — Anthropic thinking rejects it
    expect("temperature" in arg).toBe(false);
    // Claude 4.x uses adaptive thinking + output_config.effort (the older
    // type:"enabled"+budgetTokens shape is rejected by these models).
    expect(arg.providerOptions).toEqual({
      anthropic: {
        thinking: { type: "adaptive" },
        outputConfig: { effort: "medium" },
      },
    });
  });

  it("omits temperature entirely when an openai-prefixed model is used with effort", () => {
    const openaiModel = { modelId: "openai/gpt-5.2" };
    streamAgentReply({
      messages: MESSAGES,
      telemetry: TELEMETRY,
      effort: "low",
      model: openaiModel as Parameters<typeof streamAgentReply>[0]["model"],
    });
    const arg = mocks.streamText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("temperature" in arg).toBe(false);
    expect(arg.providerOptions).toEqual({
      openai: { reasoningEffort: "low", reasoningSummary: "detailed" },
    });
  });
});

// ── reasoningRequestConfig unit tests ────────────────────────────────────────

describe("reasoningRequestConfig (@oxagen/ai)", () => {
  it("returns no providerOptions and temperatureLocked=false when effort is undefined", () => {
    const result = reasoningRequestConfig(
      "anthropic/claude-opus-4.8",
      undefined,
    );
    expect(result.providerOptions).toBeUndefined();
    expect(result.temperatureLocked).toBe(false);
  });

  describe("anthropic vendor", () => {
    it("sets adaptive thinking + output_config.effort and locks temperature", () => {
      const result = reasoningRequestConfig(
        "anthropic/claude-sonnet-5",
        "medium",
      );
      expect(result.temperatureLocked).toBe(true);
      expect(result.providerOptions).toEqual({
        anthropic: {
          thinking: { type: "adaptive" },
          outputConfig: { effort: "medium" },
        },
      });
    });

    it("passes the effort level through to outputConfig (low)", () => {
      const result = reasoningRequestConfig("anthropic/claude-opus-4.8", "low");
      const opts = result.providerOptions?.anthropic as {
        thinking: { type: string };
        outputConfig: { effort: string };
      };
      expect(opts.thinking.type).toBe("adaptive");
      expect(opts.outputConfig.effort).toBe("low");
    });

    it("passes the effort level through to outputConfig (high)", () => {
      const result = reasoningRequestConfig(
        "anthropic/claude-opus-4.8",
        "high",
      );
      const opts = result.providerOptions?.anthropic as {
        outputConfig: { effort: string };
      };
      expect(opts.outputConfig.effort).toBe("high");
    });

    it("passes the Anthropic-only xhigh/max levels through verbatim (Opus/Sonnet)", () => {
      for (const effort of ["xhigh", "max"] as const) {
        const result = reasoningRequestConfig(
          "anthropic/claude-opus-4.8",
          effort,
        );
        const opts = result.providerOptions?.anthropic as {
          outputConfig: { effort: string };
        };
        expect(opts.outputConfig.effort).toBe(effort);
      }
    });
  });

  describe("openai vendor", () => {
    it("sets reasoningEffort + reasoningSummary and locks temperature", () => {
      const result = reasoningRequestConfig("openai/gpt-5.2", "high");
      expect(result.temperatureLocked).toBe(true);
      expect(result.providerOptions).toEqual({
        openai: { reasoningEffort: "high", reasoningSummary: "detailed" },
      });
    });

    it("passes through each portable effort level unchanged", () => {
      for (const effort of ["low", "medium", "high"] as const) {
        const result = reasoningRequestConfig("openai/o4", effort);
        expect(
          (result.providerOptions?.openai as { reasoningEffort: string })
            .reasoningEffort,
        ).toBe(effort);
      }
    });

    it("clamps the Anthropic-only xhigh/max levels down to high", () => {
      for (const effort of ["xhigh", "max"] as const) {
        const result = reasoningRequestConfig("openai/gpt-5.2", effort);
        expect(
          (result.providerOptions?.openai as { reasoningEffort: string })
            .reasoningEffort,
        ).toBe("high");
      }
    });
  });

  describe("google vendor", () => {
    it("sets thinkingConfig with includeThoughts and correct budget, does NOT lock temperature", () => {
      const result = reasoningRequestConfig("google/gemini-3-pro", "low");
      expect(result.temperatureLocked).toBe(false);
      expect(result.providerOptions).toEqual({
        google: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 },
        },
      });
    });

    it("maps high effort to 12288 budget tokens", () => {
      const result = reasoningRequestConfig("google/gemini-3-pro", "high");
      const cfg = (
        result.providerOptions?.google as {
          thinkingConfig: { thinkingBudget: number };
        }
      ).thinkingConfig;
      expect(cfg.thinkingBudget).toBe(12288);
    });

    it("maps the deeper xhigh/max levels to their larger thinking budgets", () => {
      for (const [effort, budget] of [
        ["xhigh", 24576],
        ["max", 49152],
      ] as const) {
        const result = reasoningRequestConfig("google/gemini-3-pro", effort);
        const cfg = (
          result.providerOptions?.google as {
            thinkingConfig: { thinkingBudget: number };
          }
        ).thinkingConfig;
        expect(cfg.thinkingBudget).toBe(budget);
      }
    });
  });

  describe("xai vendor", () => {
    it("sets xai reasoningEffort and does NOT lock temperature", () => {
      const result = reasoningRequestConfig("xai/grok-4", "medium");
      expect(result.temperatureLocked).toBe(false);
      expect(result.providerOptions).toEqual({
        xai: { reasoningEffort: "medium" },
      });
    });
  });

  describe("deepseek vendor", () => {
    it("returns no providerOptions (native streaming) and does NOT lock temperature", () => {
      const result = reasoningRequestConfig("deepseek/deepseek-v3.2", "high");
      expect(result.providerOptions).toBeUndefined();
      expect(result.temperatureLocked).toBe(false);
    });
  });

  describe("unknown/unrecognised vendor (back-compat)", () => {
    it("falls back to openai namespace without locking temperature", () => {
      const result = reasoningRequestConfig("somevendor/some-model", "medium");
      expect(result.temperatureLocked).toBe(false);
      expect(result.providerOptions).toEqual({
        openai: { reasoningEffort: "medium" },
      });
    });

    it("falls back to openai namespace for a plain id with no slash", () => {
      const result = reasoningRequestConfig("some-plain-model-slug", "low");
      expect(result.temperatureLocked).toBe(false);
      expect(result.providerOptions).toEqual({
        openai: { reasoningEffort: "low" },
      });
    });
  });
});
