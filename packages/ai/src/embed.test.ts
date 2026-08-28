import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock at the gateway + telemetry seam — embedText routes 100% through the
// Vercel AI Gateway (@ai-sdk/gateway) and must not expose vendor SDKs or
// ClickHouse internals to callers.
const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embeddingModel: vi.fn(),
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
  warn: vi.fn(),
}));

// Stub the AI SDK embed call.
mocks.embed.mockImplementation(async () => ({
  embedding: new Array(1536).fill(0).map((_, i) => i / 1536),
  usage: { tokens: 7 },
}));
mocks.embeddingModel.mockReturnValue({
  modelId: "openai/text-embedding-3-small",
});
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
});

vi.mock("ai", () => ({ embed: mocks.embed }));
vi.mock("@ai-sdk/gateway", () => ({
  gateway: { embeddingModel: mocks.embeddingModel },
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
      return head === "openai" ? "openai" : "";
    },
  };
});

import { requireScope, runInTenantScope } from "@oxagen/tenancy";
import { embedText } from "./embed";

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
    // Restore the default healthy embed response (some tests override it).
    mocks.embed.mockImplementation(async () => ({
      embedding: new Array(1536).fill(0).map((_, i) => i / 1536),
      usage: { tokens: 7 },
    }));
  });

  it("calls the gateway embedding model with the correct model id and returns a 1536-d vector", async () => {
    const v = await embedText("hello", { telemetry: BASE_TELEMETRY });
    expect(v).toHaveLength(1536);
    expect(mocks.embeddingModel).toHaveBeenCalledWith(
      "openai/text-embedding-3-small",
    );
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
    expect(row.model).toBe("text-embedding-3-small");
    expect(row.provider).toBe("openai");
    expect(row.input_tokens).toBe(7);
    expect(row.output_tokens).toBe(0);
  });

  it("swallows telemetry errors and still returns the embedding", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("clickhouse down"));
    const v = await embedText("resilient", {
      telemetry: {
        orgId: "00000000-0000-4000-8000-000000000003",
        workspaceId: "00000000-0000-4000-8000-000000000004",
        surface: "api",
        executionStepId: "req_xyz",
      },
    });
    // Embedding must succeed even when ClickHouse is unreachable.
    expect(v).toHaveLength(1536);
  });

  it("debits credits via chargeUsageCredits exactly once with the correct fields", async () => {
    await embedText("charge me", { telemetry: BASE_TELEMETRY });
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
    expect(mocks.chargeUsageCredits).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000001",
      model: "text-embedding-3-small",
      referenceId: "req_abc",
      inputTokens: 7,
      outputTokens: 0,
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

  it("swallows credit-charge errors and still returns the embedding", async () => {
    mocks.chargeUsageCredits.mockRejectedValueOnce(new Error("billing down"));
    const v = await embedText("resilient", { telemetry: BASE_TELEMETRY });
    // Embedding must succeed even when billing is unreachable.
    expect(v).toHaveLength(1536);
  });

  // Regression: ingestion embeds (embedEntity / dedup resolve / repo-file embed)
  // have no execution step and now pass executionStepId: null instead of a
  // synthesized non-UUID string like `embed:<nodeId>`. The null must flow
  // verbatim into the token_usage row (insertTokenUsage coalesces it to the nil
  // UUID) and the credit referenceId must become undefined (→ NULL), NEVER a
  // non-UUID string — otherwise the CH row drops and the credit charge throws &
  // is swallowed (unbilled embeddings). Fails on the pre-fix code (executionStepId
  // was typed `string`, callers sent `embed:<nodeId>`).
  it("passes null execution_step_id through to token_usage when there is no step", async () => {
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
    expect(rows[0]!.execution_step_id).toBeNull();
    // It must never be a synthesized correlation string.
    expect(typeof rows[0]!.execution_step_id).not.toBe("string");
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
      embedding: new Array(1536).fill(0),
      usage: undefined,
    }));
    const v = await embedText("no usage", { telemetry: BASE_TELEMETRY });
    expect(v).toHaveLength(1536);
    // The missing-usage gap must be logged, not silently zeroed.
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [meta, msg] = mocks.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toContain("usage field absent");
    expect(meta).toMatchObject({
      model: "text-embedding-3-small",
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
