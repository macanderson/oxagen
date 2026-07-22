import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateObject: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerFromModelId: vi.fn(),
  defaultModel: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
  setAttributes: vi.fn(),
}));

vi.mock("ai", () => ({
  streamText: mocks.streamText,
  generateObject: mocks.generateObject,
}));
vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  insertTokenUsage: mocks.insertTokenUsage,
  hashPrompt: mocks.hashPrompt,
  providerFromModelId: mocks.providerFromModelId,
}));
vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  providerCostUsdMicros: mocks.providerCostUsdMicros,
  chargeUsageCredits: mocks.chargeUsageCredits,
}));
vi.mock("@opentelemetry/api", () => ({
  SpanKind: { CLIENT: 2 },
  SpanStatusCode: { OK: 1 },
  context: { active: vi.fn(() => ({})), with: vi.fn((_ctx, fn) => fn()) },
  trace: {
    getTracer: vi.fn(() => ({
      startSpan: vi.fn(() => ({
        setAttributes: mocks.setAttributes,
        setStatus: vi.fn(),
        end: vi.fn(),
      })),
    })),
    setSpan: vi.fn(() => ({})),
  },
}));
vi.mock("./models", () => ({
  defaultModel: mocks.defaultModel,
  modelIdOf: (model: { modelId: string }) => model.modelId,
}));

import { generateObjectFor } from "./generate-object";
import { streamAgentReply } from "./stream";

const telemetry = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "api" as const,
  messageId: "00000000-0000-4000-8000-000000000003",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaultModel.mockReturnValue({ modelId: "anthropic/claude-sonnet-5" });
  mocks.providerFromModelId.mockReturnValue("anthropic");
  mocks.hashPrompt.mockResolvedValue("prompt-hash");
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.providerCostUsdMicros.mockReturnValue(1);
  mocks.chargeUsageCredits.mockResolvedValue({
    costUsdMicros: 1,
    creditsMetered: 1n,
    creditsCharged: 1n,
    shortfallCredits: 0n,
  });
});

describe("cache-write token telemetry", () => {
  it("meters stream cacheCreationTokens to ClickHouse and OTEL", async () => {
    mocks.streamText.mockImplementation((options) => ({
      _onFinish: options.onFinish,
    }));

    const result = streamAgentReply({
      messages: [{ role: "user", content: "hello" }],
      telemetry,
    }) as ReturnType<typeof streamAgentReply> & {
      _onFinish: (event: unknown) => Promise<void>;
    };
    await result._onFinish({
      text: "hi",
      totalUsage: {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        inputTokenDetails: { cacheReadTokens: 40, cacheCreationTokens: 25 },
      },
      finishReason: "stop",
    });

    const rows = mocks.insertTokenUsage.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.cache_write_tokens).toBe(25);
    expect(mocks.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "ai.cache_write_tokens": 25 }),
    );
  });

  it("meters generateObject cacheCreationTokens to ClickHouse", async () => {
    mocks.generateObject.mockResolvedValue({
      object: { answer: "ok" },
      usage: {
        inputTokens: 80,
        outputTokens: 4,
        totalTokens: 84,
        inputTokenDetails: { cacheReadTokens: 30, cacheCreationTokens: 12 },
      },
      finishReason: "stop",
    });

    await generateObjectFor({
      schema: z.object({ answer: z.string() }),
      prompt: "answer",
      telemetry,
    });

    const rows = mocks.insertTokenUsage.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.cache_write_tokens).toBe(12);
  });
});
