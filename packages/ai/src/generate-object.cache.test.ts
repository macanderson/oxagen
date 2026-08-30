import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Isolated coverage for the opt-in cache branch of generateObjectFor. The base
// behavior lives in generate-object.test.ts; here we mock ./cache so no DB is
// touched and assert the hit-skips-everything / miss-writes-through contract.
const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerFromModelId: vi.fn(),
  defaultModel: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
  readCache: vi.fn(),
  writeCache: vi.fn(),
}));

mocks.generateObject.mockResolvedValue({
  object: { title: "Fresh" },
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  finishReason: "stop",
});
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("cafebabe");
mocks.providerFromModelId.mockReturnValue("anthropic");
mocks.defaultModel.mockReturnValue({ modelId: "openai/gpt" });
mocks.providerCostUsdMicros.mockReturnValue(156);
mocks.chargeUsageCredits.mockResolvedValue({ costUsdMicros: 156 });
mocks.writeCache.mockResolvedValue(undefined);

vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@oxagen/telemetry", () => ({
  hashPrompt: mocks.hashPrompt,
  insertTokenUsage: mocks.insertTokenUsage,
  providerFromModelId: mocks.providerFromModelId,
}));
vi.mock("@oxagen/billing", () => ({
  providerCostUsdMicros: mocks.providerCostUsdMicros,
  chargeUsageCredits: mocks.chargeUsageCredits,
}));
vi.mock("@oxagen/tenancy", () => ({
  getScope: () => undefined,
  runInTenantScope: async (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("./models", () => ({
  defaultModel: mocks.defaultModel,
  modelIdOf: (m: { modelId: string } | string) =>
    typeof m === "string" ? m : m.modelId,
}));
vi.mock("./cache", () => ({
  readCache: mocks.readCache,
  writeCache: mocks.writeCache,
  sha256Hex: (s: string) => `sha:${s}`,
}));

import { generateObjectFor } from "./generate-object";

const SCHEMA = z.object({ title: z.string() });
const TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "ingestion" as const,
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateObject.mockResolvedValue({
    object: { title: "Fresh" },
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    finishReason: "stop",
  });
  mocks.hashPrompt.mockResolvedValue("cafebabe");
  mocks.providerFromModelId.mockReturnValue("anthropic");
  mocks.providerCostUsdMicros.mockReturnValue(156);
  mocks.chargeUsageCredits.mockResolvedValue({ costUsdMicros: 156 });
  mocks.writeCache.mockResolvedValue(undefined);
});

describe("generateObjectFor cache option", () => {
  it("serves a hit without calling the model, telemetry, credit charge, or writeCache", async () => {
    mocks.readCache.mockResolvedValue({
      hit: {
        value: { title: "Cached" },
        usage: {
          model: "openai/gpt",
          inputTokens: 3,
          outputTokens: 2,
          cachedTokens: 0,
          costUsdMicros: 9,
        },
        kind: "object",
        semantic: false,
        similarity: 1,
      },
    });

    const res = await generateObjectFor({
      schema: SCHEMA,
      model: { modelId: "openai/gpt" } as never,
      prompt: "classify me",
      telemetry: TELEMETRY,
      cache: { ttlSeconds: 3600 },
    });

    expect(res.object).toEqual({ title: "Cached" });
    expect(res.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
    expect(mocks.chargeUsageCredits).not.toHaveBeenCalled();
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });

  it("on a miss, calls the model, writes through the cache, and meters normally", async () => {
    mocks.readCache.mockResolvedValue({
      hit: null,
      queryEmbedding: [0.5, 0.5],
    });

    const res = await generateObjectFor({
      schema: SCHEMA,
      model: { modelId: "openai/gpt" } as never,
      prompt: "classify me",
      telemetry: TELEMETRY,
      cache: { ttlSeconds: 3600, semantic: true },
    });

    expect(res.object).toEqual({ title: "Fresh" });
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    // Write-through reuses the read's query embedding (no second embed).
    expect(mocks.writeCache).toHaveBeenCalledTimes(1);
    const writeArgs = mocks.writeCache.mock.calls[0]!;
    expect(writeArgs[2]).toEqual({ title: "Fresh" }); // value
    expect(writeArgs[5]).toEqual([0.5, 0.5]); // precomputed embedding
  });

  it("does not touch the cache when no cache option is passed", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      model: { modelId: "openai/gpt" } as never,
      prompt: "no cache",
      telemetry: TELEMETRY,
    });
    expect(mocks.readCache).not.toHaveBeenCalled();
    expect(mocks.writeCache).not.toHaveBeenCalled();
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });
});
