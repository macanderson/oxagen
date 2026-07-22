import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertTokenUsage: vi.fn(),
  hashPrompt: vi.fn(),
  providerFromModelId: vi.fn(),
  providerCostUsdMicros: vi.fn(),
  chargeUsageCredits: vi.fn(),
  runInTenantScope: vi.fn(),
  getScope: vi.fn(),
}));

mocks.insertTokenUsage.mockResolvedValue(undefined);
mocks.hashPrompt.mockResolvedValue("hash");
mocks.providerFromModelId.mockReturnValue("anthropic");
mocks.providerCostUsdMicros.mockReturnValue(100);
mocks.chargeUsageCredits.mockResolvedValue({ costUsdMicros: 100 });
mocks.runInTenantScope.mockImplementation(
  async (_s: unknown, fn: () => unknown) => fn(),
);
mocks.getScope.mockReturnValue(undefined);

vi.mock("@oxagen/telemetry", () => ({
  insertTokenUsage: mocks.insertTokenUsage,
  hashPrompt: mocks.hashPrompt,
  providerFromModelId: mocks.providerFromModelId,
}));
vi.mock("@oxagen/billing", () => ({
  providerCostUsdMicros: mocks.providerCostUsdMicros,
  chargeUsageCredits: mocks.chargeUsageCredits,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
  getScope: mocks.getScope,
}));

import { submitBatch, pollBatch } from "./batch";

const TELEMETRY = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "ingestion" as const,
};

type BatchesMock = {
  create: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  results: ReturnType<typeof vi.fn>;
};
function makeClient(overrides: Partial<BatchesMock> = {}): BatchesMock {
  return {
    create: vi.fn().mockResolvedValue({
      id: "msgbatch_1",
      processing_status: "in_progress",
    }),
    retrieve: vi.fn(),
    results: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertTokenUsage.mockResolvedValue(undefined);
  mocks.hashPrompt.mockResolvedValue("hash");
  mocks.providerFromModelId.mockReturnValue("anthropic");
  mocks.providerCostUsdMicros.mockReturnValue(100);
  mocks.chargeUsageCredits.mockResolvedValue({ costUsdMicros: 100 });
  mocks.runInTenantScope.mockImplementation(
    async (_s: unknown, fn: () => unknown) => fn(),
  );
  mocks.getScope.mockReturnValue(undefined);
});

describe("submitBatch", () => {
  it("maps each request to an Anthropic batch request and returns the batch id", async () => {
    const client = makeClient();
    const res = await submitBatch({
      model: "claude-haiku-4-5",
      requests: [
        { customId: "f1", prompt: "classify a", maxTokens: 100 },
        {
          customId: "f2",
          system: "sys",
          prompt: "classify b",
          maxTokens: 200,
          temperature: 0.5,
        },
      ],
      telemetry: TELEMETRY,
      client: client as never,
    });
    expect(res.batchId).toBe("msgbatch_1");
    expect(res.requestCount).toBe(2);
    const arg = (client.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.requests).toHaveLength(2);
    expect(arg.requests[0]).toMatchObject({
      custom_id: "f1",
      params: {
        model: "claude-haiku-4-5",
        max_tokens: 100,
        temperature: 0,
        messages: [{ role: "user", content: "classify a" }],
      },
    });
    expect(arg.requests[1].params.system).toBe("sys");
    expect(arg.requests[1].params.temperature).toBe(0.5);
  });

  it("throws on an empty request list", async () => {
    await expect(
      submitBatch({
        model: "claude-haiku-4-5",
        requests: [],
        telemetry: TELEMETRY,
        client: makeClient(),
      }),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("pollBatch", () => {
  it("reports not-ended without decoding results", async () => {
    const client = makeClient({
      retrieve: vi.fn().mockResolvedValue({
        processing_status: "in_progress",
        request_counts: {
          succeeded: 0,
          errored: 0,
          canceled: 0,
          expired: 0,
          processing: 3,
        },
      }),
    });
    const res = await pollBatch({
      batchId: "msgbatch_1",
      model: "claude-haiku-4-5",
      telemetry: TELEMETRY,
      client: client as never,
    });
    expect(res.ended).toBe(false);
    expect(res.counts.processing).toBe(3);
    expect(res.results).toEqual([]);
    expect(client.results).not.toHaveBeenCalled();
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
  });

  it("decodes results and meters succeeded requests on an ended batch", async () => {
    const entries = [
      {
        custom_id: "f1",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: '{"features":[]}' }],
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 6,
            },
          },
        },
      },
      {
        custom_id: "f2",
        result: {
          type: "errored",
          error: { type: "invalid_request", message: "bad" },
        },
      },
      { custom_id: "f3", result: { type: "expired" } },
    ];
    const client = makeClient({
      retrieve: vi.fn().mockResolvedValue({
        processing_status: "ended",
        request_counts: {
          succeeded: 1,
          errored: 1,
          canceled: 0,
          expired: 1,
          processing: 0,
        },
      }),
      results: vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const e of entries) yield e;
        },
      }),
    });

    const res = await pollBatch({
      batchId: "msgbatch_1",
      model: "claude-haiku-4-5",
      telemetry: TELEMETRY,
      client: client as never,
    });
    expect(res.ended).toBe(true);
    expect(res.counts).toMatchObject({ succeeded: 1, errored: 1, expired: 1 });
    expect(res.results).toHaveLength(3);

    const ok = res.results.find((r) => r.customId === "f1");
    expect(ok?.type).toBe("succeeded");
    expect(ok?.text).toBe('{"features":[]}');
    // Raw Anthropic batch usage is ADDITIVE (input_tokens excludes cache), so the
    // normalized inputTokens is the INCLUSIVE total: 20 fresh + 4 read + 6 write = 30.
    expect(ok?.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      cachedTokens: 4,
      cacheWriteTokens: 6,
    });

    const errored = res.results.find((r) => r.customId === "f2");
    expect(errored?.type).toBe("errored");
    expect(errored?.error).toContain("invalid_request");

    // Metering: one token_usage row for the single succeeded request + a charge.
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const rows = mocks.insertTokenUsage.mock.calls[0]![0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      input_tokens: 30,
      output_tokens: 10,
      cached_tokens: 4,
      cache_write_tokens: 6,
      surface: "ingestion",
    });
    expect(mocks.chargeUsageCredits).toHaveBeenCalledTimes(1);
  });

  it("skips metering when meter=false", async () => {
    const client = makeClient({
      retrieve: vi.fn().mockResolvedValue({
        processing_status: "ended",
        request_counts: {
          succeeded: 1,
          errored: 0,
          canceled: 0,
          expired: 0,
          processing: 0,
        },
      }),
      results: vi.fn().mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield {
            custom_id: "f1",
            result: {
              type: "succeeded",
              message: {
                content: [{ type: "text", text: "ok" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          };
        },
      }),
    });
    const res = await pollBatch({
      batchId: "msgbatch_1",
      model: "claude-haiku-4-5",
      telemetry: TELEMETRY,
      client: client as never,
      meter: false,
    });
    expect(res.ended).toBe(true);
    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
    expect(mocks.chargeUsageCredits).not.toHaveBeenCalled();
  });
});

describe("anthropic key requirement", () => {
  it("throws a clear error when ANTHROPIC_API_KEY is absent and no client is injected", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        submitBatch({
          model: "claude-haiku-4-5",
          requests: [{ customId: "f1", prompt: "x", maxTokens: 10 }],
          telemetry: TELEMETRY,
        }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
