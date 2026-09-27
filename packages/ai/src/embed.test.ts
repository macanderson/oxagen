import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock at the Voyage model + telemetry seam. embedText sends every embedding to
// Voyage on the platform key (#4148) and must not expose vendor details or
// ClickHouse internals to callers.
const mocks = vi.hoisted(() => ({
  voidUsage: vi.fn(async () => true),
  recordSpend: vi.fn(),
  embed: vi.fn(),
  embedMany: vi.fn(),
  createVoyageEmbeddingModel: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
  warn: vi.fn(),
}));

// Stub the AI SDK embed call.
mocks.embed.mockImplementation(async () => ({
  embedding: new Array(1024).fill(0).map((_, i) => i / 1024),
  usage: { tokens: 7 },
}));
mocks.embedMany.mockImplementation(
  async ({ values }: { values: string[] }) => ({
    embeddings: values.map((_, n) =>
      new Array(1024).fill(0).map((_v, i) => (i + n) / 1024),
    ),
    usage: { tokens: 7 * values.length },
  }),
);
mocks.createVoyageEmbeddingModel.mockImplementation(
  (options: { modelId: string }) => ({
    modelId: options.modelId,
    provider: "voyage",
  }),
);
// Telemetry stubs.
mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("deadbeefdeadbeef");
// Billing stubs.
mocks.providerCostUsdMicros.mockReturnValue(42);
mocks.chargeUsageCredits.mockResolvedValue({
  costUsdMicros: 42,
  creditsMetered: 1n,
  creditsCharged: 1n,
  shortfallCredits: 0n,
  rateCardMiss: false,
});

vi.mock("ai", () => ({ embed: mocks.embed, embedMany: mocks.embedMany }));
vi.mock("./voyage", () => ({
  createVoyageEmbeddingModel: mocks.createVoyageEmbeddingModel,
}));
// Stub pino so the usage-absent warning is observable.
vi.mock("pino", () => ({
  default: vi.fn(() => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn() })),
}));
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    providerCostUsdMicros: mocks.providerCostUsdMicros,
    chargeUsageCredits: mocks.chargeUsageCredits,
    admitUsage: vi.fn(async () => "00000000-0000-4000-8000-000000000099"),
    finalizeUsage: vi.fn(
      async ({ row, charge }: { row: unknown; charge?: unknown }) => {
        await mocks.insertTokenUsage([row]);
        if (charge) await mocks.chargeUsageCredits(charge);
      },
    ),
    recordSpend: mocks.recordSpend,
    voidUsage: mocks.voidUsage,
  };
});
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertTokenUsage: mocks.insertTokenUsage,
    hashPrompt: mocks.hashPrompt,
    providerFromModelId: (id: string) => {
      const head = id.split(":")[0] ?? "";
      return head === "voyage" ? "voyage" : "";
    },
  };
});

import { APICallError } from "@ai-sdk/provider";
import { requireScope, runInTenantScope } from "@oxagen/tenancy";
import { embedText, EmbeddingUnavailableError } from "./embed";

// The platform key the Voyage model is built with. Stubbed per test so a
// missing key can be tested too.
beforeEach(() => {
  vi.stubEnv("VOYAGE_API_KEY", "pa-test");
});

const BASE_TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "runner" as const,
  executionStepId: "req_abc",
};

describe("embedText (@oxagen/ai)", () => {
  beforeEach(() => {
    mocks.embed.mockClear();
    mocks.insertTokenUsage.mockClear();
    mocks.hashPrompt.mockClear();
    mocks.providerCostUsdMicros.mockClear();
    mocks.chargeUsageCredits.mockClear();
    mocks.warn.mockClear();
    mocks.createVoyageEmbeddingModel.mockClear();
    // Restore the default healthy embed response (some tests override it).
    mocks.embed.mockImplementation(async () => ({
      embedding: new Array(1024).fill(0).map((_, i) => i / 1024),
      usage: { tokens: 7 },
    }));
  });

  it("embeds with voyage-4-large at 1,024 dimensions on the platform key", async () => {
    const v = await embedText("hello", { telemetry: BASE_TELEMETRY });
    expect(v).toHaveLength(1024);
    expect(mocks.createVoyageEmbeddingModel).toHaveBeenCalledWith({
      apiKey: "pa-test",
      modelId: "voyage-4-large",
      outputDimension: 1024,
      inputType: undefined,
    });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const args = mocks.embed.mock.calls[0]?.[0] as { value: string };
    expect(args.value).toBe("hello");
  });

  it("always writes a token_usage row — telemetry is required for metering", async () => {
    await embedText("meter me", { telemetry: BASE_TELEMETRY });
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("writes exactly ONE token_usage row with the correct fields", async () => {
    await embedText("meter me", {
      telemetry: {
        orgId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        surface: "runner",
        executionStepId: "req_abc",
      },
    });
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const firstCall = mocks.insertTokenUsage.mock.calls[0] as [
      unknown[],
      ...unknown[],
    ];
    const rows: unknown[] = firstCall[0];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.org_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(row.workspace_id).toBe("00000000-0000-4000-8000-000000000002");
    expect(row.surface).toBe("runner");
    expect(row.execution_step_id).toBe("req_abc");
    expect(row.model).toBe("voyage-4-large");
    expect(row.provider).toBe("voyage");
    expect(row.input_tokens).toBe(7);
    expect(row.output_tokens).toBe(0);
  });

  it("rejects when the settlement seam rejects after the usage is staged; the outbox retries it", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      embedText("resilient", {
        telemetry: {
          orgId: "00000000-0000-4000-8000-000000000003",
          workspaceId: "00000000-0000-4000-8000-000000000004",
          surface: "api",
          executionStepId: "req_xyz",
        },
      }),
    ).rejects.toThrow("clickhouse down");
  });

  it("voids the admission and throws EmbeddingUnavailableError when the provider call fails", async () => {
    mocks.embed.mockRejectedValueOnce(new Error("voyage 502"));
    const err = await embedText("resilient", {
      telemetry: BASE_TELEMETRY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect((err as EmbeddingUnavailableError).code).toBe(
      "embedding_unavailable",
    );
    expect((err as EmbeddingUnavailableError).providerMessage).toBe(
      "voyage 502",
    );
    expect(mocks.voidUsage).toHaveBeenCalledWith({
      id: "00000000-0000-4000-8000-000000000099",
      orgId: BASE_TELEMETRY.orgId,
      workspaceId: BASE_TELEMETRY.workspaceId,
      reason: "provider_call_failed",
    });
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
    expect(mocks.chargeUsageCredits).not.toHaveBeenCalled();
  });

  it("debits credits via chargeUsageCredits exactly once with the correct fields", async () => {
    await embedText("charge me", { telemetry: BASE_TELEMETRY });
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000001",
      model: "voyage-4-large",
      referenceId: "req_abc",
      inputTokens: 7,
      outputTokens: 0,
      reason: "consume_embedding",
      cachedTokens: 0,
    });
  });

  // ── Tenant-scope regression (Inngest billing leak) ─────────────────────────
  // chargeUsageCredits → consumeCredits → withTenantDb → requireScope. Old code
  // charged scopeless when embedText ran inside an Inngest function / ingestion
  // worker (no ambient scope) → TenantScopeError → swallowed → unbilled embed.
  // The helper must establish the scope from telemetry around the charge. These
  // mocks call the real requireScope() gate: FAIL on old code, PASS on new. Uses
  // mockImplementationOnce because embed's beforeEach only mockClear()s the mock.
  it("charges inside a tenant scope when none is ambient (Inngest/ingestion path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeUsageCredits.mockImplementationOnce(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 42,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
        rateCardMiss: false,
      };
    });

    await embedText("inngest embed", { telemetry: BASE_TELEMETRY });

    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(chargeSucceeded).toBe(true);
  });

  it("charges successfully when a tenant scope is already active (request path)", async () => {
    let chargeSucceeded = false;
    mocks.chargeUsageCredits.mockImplementationOnce(async () => {
      requireScope();
      chargeSucceeded = true;
      return {
        costUsdMicros: 42,
        creditsMetered: 1n,
        creditsCharged: 1n,
        shortfallCredits: 0n,
        rateCardMiss: false,
      };
    });

    await runInTenantScope(
      { orgId: BASE_TELEMETRY.orgId, workspaceId: BASE_TELEMETRY.workspaceId },
      async () => {
        await embedText("request embed", { telemetry: BASE_TELEMETRY });
      },
    );

    expect(chargeSucceeded).toBe(true);
  });

  it("rejects when the credit charge fails after the usage is staged; the outbox retries it", async () => {
    mocks.chargeUsageCredits.mockRejectedValueOnce(new Error("billing down"));
    await expect(
      embedText("resilient", { telemetry: BASE_TELEMETRY }),
    ).rejects.toThrow("billing down");
  });

  // Regression: ingestion embeds (embedEntity / dedup resolve / repo-file embed)
  // have no execution step and now pass executionStepId: null instead of a
  // synthesized non-UUID string like `embed:<nodeId>`. The null must flow
  // verbatim into the token_usage row (insertTokenUsage coalesces it to the nil
  // UUID) and the credit referenceId must become undefined (→ NULL), NEVER a
  // non-UUID string — otherwise the CH row drops and the credit charge throws &
  // is swallowed (unbilled embeddings). Fails on the pre-fix code (executionStepId
  // was typed `string`, callers sent `embed:<nodeId>`).
  it("stores the nil UUID for an absent execution step", async () => {
    await embedText("ingestion embed", {
      telemetry: {
        orgId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        surface: "ingestion",
        executionStepId: null,
      },
    });
    const rows = (
      mocks.insertTokenUsage.mock.calls[0] as [Record<string, unknown>[]]
    )[0];
    expect(rows[0]!.execution_step_id).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
  });

  it("charges credits with referenceId undefined (not a non-UUID string) when there is no step", async () => {
    await embedText("ingestion embed", {
      telemetry: {
        orgId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        surface: "ingestion",
        executionStepId: null,
      },
    });
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    const arg = mocks.chargeUsageCredits.mock.calls[0]![0] as {
      referenceId?: string;
    };
    expect(arg.referenceId).toBeUndefined();
  });

  it("warns and bills zero tokens when the embed() response omits usage", async () => {
    mocks.embed.mockImplementationOnce(async () => ({
      embedding: new Array(1024).fill(0),
      usage: undefined,
    }));
    const v = await embedText("no usage", { telemetry: BASE_TELEMETRY });
    expect(v).toHaveLength(1024);
    // The missing-usage gap must be logged, not silently zeroed.
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = mocks.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toContain("usage field absent");
    expect(meta).toMatchObject({
      model: "voyage-4-large",
      executionStepId: "req_abc",
    });
    // token_usage row and credit charge still recorded, with zero input tokens.
    const usageRow = (
      mocks.insertTokenUsage.mock.calls[0] as [Record<string, unknown>[]]
    )[0][0]!;
    expect(usageRow.input_tokens).toBe(0);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// #4148: one platform Voyage key for every organisation, and a typed failure
// ---------------------------------------------------------------------------

describe("embedText on the platform Voyage key (#4148)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embed.mockImplementation(async () => ({
      embedding: new Array(1024).fill(0).map((_, i) => i / 1024),
      usage: { tokens: 7 },
    }));
    mocks.hashPrompt.mockResolvedValue("deadbeefdeadbeef");
    mocks.providerCostUsdMicros.mockReturnValue(42);
    mocks.chargeUsageCredits.mockResolvedValue({
      costUsdMicros: 42,
      creditsMetered: 1n,
      creditsCharged: 1n,
      shortfallCredits: 0n,
      rateCardMiss: false,
    });
  });

  it("passes the input type to Voyage", async () => {
    await embedText("what did the agent change", {
      telemetry: BASE_TELEMETRY,
      inputType: "query",
    });
    expect(mocks.createVoyageEmbeddingModel).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: "query" }),
    );
  });

  it("charges every embedding, since Oxagen's key serves it", async () => {
    await embedText("platform", { telemetry: BASE_TELEMETRY });
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
  });

  it("throws EmbeddingUnavailableError before admitting usage when VOYAGE_API_KEY is unset", async () => {
    // The top-level beforeEach stubs it again for the next test.
    delete process.env.VOYAGE_API_KEY;
    const err = await embedText("no key", { telemetry: BASE_TELEMETRY }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
  });

  it("throws EmbeddingUnavailableError, not a config error, when VOYAGE_API_KEY is empty", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    const err = await embedText("no key", { telemetry: BASE_TELEMETRY }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect((err as Error).message).toContain("VOYAGE_API_KEY is not set");
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
    expect(mocks.chargeUsageCredits).not.toHaveBeenCalled();
  });

  it("carries Voyage's status and message when it refuses the key", async () => {
    mocks.embed.mockRejectedValueOnce(
      new APICallError({
        message: "Voyage embeddings returned 401",
        url: "https://api.voyageai.com/v1/embeddings",
        requestBodyValues: {},
        statusCode: 401,
        responseBody: '{"detail":"Provided API key is invalid."}',
        isRetryable: false,
      }),
    );
    const err = (await embedText("refused", {
      telemetry: BASE_TELEMETRY,
    }).catch((e: unknown) => e)) as EmbeddingUnavailableError;
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(err.statusCode).toBe(401);
    expect(err.providerMessage).toContain("Provided API key is invalid");
    expect(err.message).toContain("Voyage answered 401");
  });

  it("reads the last attempt when the SDK gives up after its retries", async () => {
    mocks.embed.mockRejectedValueOnce(
      Object.assign(new Error("Failed after 3 attempts"), {
        lastError: new APICallError({
          message: "Voyage embeddings returned 503",
          url: "https://api.voyageai.com/v1/embeddings",
          requestBodyValues: {},
          statusCode: 503,
          responseBody: "upstream unavailable",
          isRetryable: true,
        }),
      }),
    );
    const err = (await embedText("retried", {
      telemetry: BASE_TELEMETRY,
    }).catch((e: unknown) => e)) as EmbeddingUnavailableError;
    expect(err.statusCode).toBe(503);
    expect(err.providerMessage).toBe("upstream unavailable");
  });
});

// ---------------------------------------------------------------------------
// embedMany — one call, one charge (#1413)
// ---------------------------------------------------------------------------

describe("embedMany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hashPrompt.mockResolvedValue("deadbeefdeadbeef");
    mocks.providerCostUsdMicros.mockReturnValue(42);
    mocks.chargeUsageCredits.mockResolvedValue({
      costUsdMicros: 42,
      creditsMetered: 1n,
      creditsCharged: 1n,
      shortfallCredits: 0n,
      rateCardMiss: false,
    });
  });

  const telemetry = {
    orgId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    surface: "api" as const,
    executionStepId: null,
  };

  it("builds the model with the batch's input type", async () => {
    const { embedMany } = await import("./embed");
    await embedMany(["a", "b"], { telemetry, inputType: "document" });
    expect(mocks.createVoyageEmbeddingModel).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: "document" }),
    );
  });

  it("embeds a batch in ONE provider call and charges ONE time", async () => {
    const { embedMany } = await import("./embed");

    const vectors = await embedMany(["alpha", "beta", "gamma"], { telemetry });

    expect(vectors).toHaveLength(3);
    // One round trip, carrying every value.
    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
    expect(mocks.embedMany.mock.calls[0]![0]).toMatchObject({
      values: ["alpha", "beta", "gamma"],
    });
    // One charge and one telemetry row for the batch — the per-item shape was
    // three of each.
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    // Charged for the batch's whole token count, not one item's.
    expect(mocks.chargeUsageCredits.mock.calls[0]![0]).toMatchObject({
      inputTokens: 21,
      outputTokens: 0,
    });
  });

  it("does no work and meters nothing for an empty batch", async () => {
    const { embedMany } = await import("./embed");

    await expect(embedMany([], { telemetry })).resolves.toEqual([]);
    expect(mocks.embedMany).not.toHaveBeenCalled();
    expect(mocks.chargeUsageCredits).not.toHaveBeenCalled();
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
  });

  it("warns rather than silently billing zero when usage is absent", async () => {
    mocks.embedMany.mockResolvedValueOnce({
      embeddings: [[0.1], [0.2]],
      usage: undefined,
    });
    const { embedMany } = await import("./embed");

    await embedMany(["alpha", "beta"], { telemetry });

    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.chargeUsageCredits.mock.calls[0]![0]).toMatchObject({
      inputTokens: 0,
    });
  });
});
