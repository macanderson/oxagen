import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerFromModelId: vi.fn(),
  defaultModel: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
}));

// Fixed object the mock model always returns.
const FIXED_OBJECT = { answer: "Paris", confidence: 0.99 };

// generateObject resolves immediately with a fixed result — no real LLM.
mocks.generateObject.mockResolvedValue({
  object: FIXED_OBJECT,
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  finishReason: "stop",
});
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("cafebabe");
mocks.providerFromModelId.mockReturnValue("anthropic");
mocks.defaultModel.mockReturnValue({ modelId: "claude-sonnet-5" });
// 12 input @ $3/1M + 8 output @ $15/1M = 156 micro-USD.
mocks.providerCostUsdMicros.mockReturnValue(156);
mocks.chargeUsageCredits.mockResolvedValue({
  costUsdMicros: 156,
  creditsMetered: 1n,
  creditsCharged: 1n,
  shortfallCredits: 0n,
});

vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
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

import { requireScope, runInTenantScope } from "@oxagen/tenancy";
import { generateObjectFor } from "./generate-object";

// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = z.object({
  answer: z.string(),
  confidence: z.number(),
});

const TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "api" as const,
  messageId: "msg_xyz",
};

beforeEach(() => {
  mocks.generateObject.mockClear();
  mocks.insertTokenUsage.mockClear();
  mocks.hashPrompt.mockClear();
  mocks.providerFromModelId.mockClear();
  mocks.providerCostUsdMicros.mockClear();
  mocks.chargeUsageCredits.mockClear();
  // restore defaults
  mocks.generateObject.mockResolvedValue({
    object: FIXED_OBJECT,
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    finishReason: "stop",
  });
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.hashPrompt.mockResolvedValue("cafebabe");
  mocks.providerFromModelId.mockReturnValue("anthropic");
  mocks.providerCostUsdMicros.mockReturnValue(156);
  mocks.chargeUsageCredits.mockResolvedValue({
    costUsdMicros: 156,
    creditsMetered: 1n,
    creditsCharged: 1n,
    shortfallCredits: 0n,
  });
});

describe("generateObjectFor (@oxagen/ai)", () => {
  it("returns an object that satisfies the zod schema", async () => {
    const { object } = await generateObjectFor({
      schema: SCHEMA,
      prompt: "What is the capital of France?",
      telemetry: TELEMETRY,
    });

    // Validate against the schema — parse() throws on mismatch.
    expect(() => SCHEMA.parse(object)).not.toThrow();
    expect(object.answer).toBe("Paris");
    expect(object.confidence).toBe(0.99);
  });

  it("returns correct usage counts from the underlying SDK result", async () => {
    const { usage } = await generateObjectFor({
      schema: SCHEMA,
      prompt: "Capital of France?",
      telemetry: TELEMETRY,
    });

    expect(usage.promptTokens).toBe(12);
    expect(usage.completionTokens).toBe(8);
    expect(usage.totalTokens).toBe(20);
  });

  it("calls generateObject with default temperature 0 and the schema", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "test",
      telemetry: TELEMETRY,
    });

    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.temperature).toBe(0);
    expect(arg.schema).toBe(SCHEMA);
  });

  it("uses the caller-supplied model and does not call defaultModel", async () => {
    const customModel = { modelId: "claude-3-haiku-20240307" };
    const before = mocks.defaultModel.mock.calls.length;

    await generateObjectFor({
      schema: SCHEMA,
      prompt: "test",
      telemetry: TELEMETRY,
      model: customModel as Parameters<typeof generateObjectFor>[0]["model"],
    });

    const after = mocks.defaultModel.mock.calls.length;
    expect(after - before).toBe(0);
    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect((arg.model as { modelId: string }).modelId).toBe(
      "claude-3-haiku-20240307",
    );
  });

  it("uses defaultModel() when no model is supplied", async () => {
    const before = mocks.defaultModel.mock.calls.length;
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "test",
      telemetry: TELEMETRY,
    });
    const after = mocks.defaultModel.mock.calls.length;
    expect(after - before).toBe(1);
  });

  it("writes a token_usage row with the correct telemetry fields", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "Capital?",
      telemetry: TELEMETRY,
    });

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(row.workspace_id).toBe("00000000-0000-4000-8000-000000000002");
    expect(row.surface).toBe("api");
    expect(row.execution_step_id).toBe("msg_xyz");
    expect(row.input_tokens).toBe(12);
    expect(row.output_tokens).toBe(8);
    expect(row.cost_usd_micros).toBe(156);
    expect(typeof row.duration_ms).toBe("number");
    expect(row.provider).toBe("anthropic");
  });

  it("writes the prompt hash into the token_usage row", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "Capital?",
      telemetry: TELEMETRY,
    });

    expect(mocks.hashPrompt).toHaveBeenCalledWith("Capital?");
    const rows = (mocks.insertTokenUsage.mock.calls[0] as [unknown[]])[0];
    const row = rows[0] as Record<string, unknown>;
    expect(row.prompt_hash).toBe("cafebabe");
  });

  it("hashes the last user message content when messages are provided", async () => {
    const messages = [
      { role: "user" as const, content: "What is the capital?" },
    ];
    await generateObjectFor({
      schema: SCHEMA,
      messages,
      telemetry: TELEMETRY,
    });

    expect(mocks.hashPrompt).toHaveBeenCalledWith("What is the capital?");
  });

  it("stringifies structured message content before hashing", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "structured" }],
      },
    ];
    await generateObjectFor({ schema: SCHEMA, messages, telemetry: TELEMETRY });
    expect(mocks.hashPrompt).toHaveBeenCalledWith(
      JSON.stringify([{ type: "text", text: "structured" }]),
    );
  });

  it("charges the org's credits through the billing gate", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "test",
      telemetry: TELEMETRY,
    });

    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000001",
      referenceId: "msg_xyz",
      model: "claude-sonnet-5",
      inputTokens: 12,
      outputTokens: 8,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("forwards prompt-cache writes (inputTokenDetails.cacheWriteTokens) to telemetry and the meter", async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: FIXED_OBJECT,
      // Flat inputTokens is the INCLUSIVE total: 20 fresh + 12 read + 8 write.
      usage: {
        inputTokens: 40,
        outputTokens: 8,
        totalTokens: 48,
        inputTokenDetails: { cacheReadTokens: 12, cacheWriteTokens: 8 },
      },
      finishReason: "stop",
    });

    await generateObjectFor({
      schema: SCHEMA,
      prompt: "test",
      telemetry: TELEMETRY,
    });

    const rows = (
      mocks.insertTokenUsage.mock.calls[0] as [Array<Record<string, unknown>>]
    )[0];
    expect(rows[0]?.cache_write_tokens).toBe(8);
    expect(rows[0]?.cached_tokens).toBe(12);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 40,
        cachedTokens: 12,
        cacheWriteTokens: 8,
      }),
    );
  });

  // ── Tenant-scope regression (Inngest billing leak) ─────────────────────────
  // chargeUsageCredits → consumeCredits → withTenantDb → requireScope. Old code
  // charged scopeless when generateObjectFor ran inside an Inngest function (no
  // ambient scope) → TenantScopeError → swallowed → unbilled call. The helper
  // must establish the scope from telemetry around the charge. These mocks call
  // the real requireScope() gate so they FAIL on the old code and PASS on new.
  it("charges inside a tenant scope when none is ambient (Inngest path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeUsageCredits.mockImplementation(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 156,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
      };
    });

    await generateObjectFor({
      schema: SCHEMA,
      prompt: "inngest step",
      telemetry: TELEMETRY,
    });

    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(chargeSucceeded).toBe(true);
  });

  it("charges successfully when a tenant scope is already active (request path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeUsageCredits.mockImplementation(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 156,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
      };
    });

    await runInTenantScope(
      { orgId: TELEMETRY.orgId, workspaceId: TELEMETRY.workspaceId },
      async () => {
        await generateObjectFor({
          schema: SCHEMA,
          prompt: "request turn",
          telemetry: TELEMETRY,
        });
      },
    );

    expect(chargeSucceeded).toBe(true);
  });

  it("swallows a ClickHouse insertTokenUsage error and still returns the object", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("CH down"));

    const { object } = await generateObjectFor({
      schema: SCHEMA,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(object.answer).toBe("Paris");
  });

  it("swallows a hashPrompt error and still returns the object", async () => {
    mocks.hashPrompt.mockRejectedValueOnce(new Error("hash failure"));

    const { object } = await generateObjectFor({
      schema: SCHEMA,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(object.answer).toBe("Paris");
  });

  it("swallows a credit-charge error and still returns the object", async () => {
    mocks.chargeUsageCredits.mockRejectedValueOnce(new Error("billing down"));

    const { object } = await generateObjectFor({
      schema: SCHEMA,
      prompt: "resilient?",
      telemetry: TELEMETRY,
    });

    expect(object.answer).toBe("Paris");
  });

  it("respects a caller-supplied temperature override", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "creative?",
      temperature: 1.2,
      telemetry: TELEMETRY,
    });

    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.temperature).toBe(1.2);
  });

  it("passes system and messages through to the underlying SDK call", async () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    await generateObjectFor({
      schema: SCHEMA,
      system: "You are a geography expert.",
      messages,
      telemetry: TELEMETRY,
    });

    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.system).toBe("You are a geography expert.");
    expect(arg.messages).toBe(messages);
  });

  it("forwards a caller-supplied abortSignal so a stalled call can be bounded", async () => {
    const signal = AbortSignal.timeout(30_000);
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "bounded?",
      telemetry: TELEMETRY,
      abortSignal: signal,
    });

    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.abortSignal).toBe(signal);
  });

  it("forwards maxRetries when provided (e.g. 0 when an outer system owns retries)", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "no retries",
      telemetry: TELEMETRY,
      maxRetries: 0,
    });

    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.maxRetries).toBe(0);
  });

  it("omits abortSignal and maxRetries entirely when the caller does not set them", async () => {
    await generateObjectFor({
      schema: SCHEMA,
      prompt: "defaults",
      telemetry: TELEMETRY,
    });

    const arg = mocks.generateObject.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("abortSignal" in arg).toBe(false);
    expect("maxRetries" in arg).toBe(false);
  });

  it("propagates an AbortError when the underlying call is aborted", async () => {
    mocks.generateObject.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      }),
    );

    await expect(
      generateObjectFor({
        schema: SCHEMA,
        prompt: "will abort",
        telemetry: TELEMETRY,
        abortSignal: AbortSignal.timeout(1),
      }),
    ).rejects.toThrow(/aborted/i);
  });
});
