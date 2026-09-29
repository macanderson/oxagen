/**
 * The meter the oxagen provider's search embeddings run under (lane M15;
 * ADR-217). These tests replace the usage outbox, the tenant scope, and the
 * logger, so they show that each request is admitted before it is sent, the
 * token_usage row's fields, that no credits are charged, that a failed request
 * voids its admission, and that a failure is logged by name and never reaches
 * search or publish.
 */
import { httpEmbedder, SearchIndexError, type EmbedUsage, type HttpTransportResponse } from "@oxagen/mcp-studio";
import { hashPrompt, NIL_UUID } from "@oxagen/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitUsage: vi.fn(),
  finalizeUsage: vi.fn(),
  voidUsage: vi.fn(),
  scopes: [] as unknown[],
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return { ...real, admitUsage: mocks.admitUsage, finalizeUsage: mocks.finalizeUsage, voidUsage: mocks.voidUsage };
});

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (scope: unknown, fn: () => unknown) => {
      mocks.scopes.push(scope);
      return fn();
    },
  };
});

vi.mock("../logger", () => ({ logger: { warn: mocks.warn, error: mocks.error, info: vi.fn() } }));

import { providerCostUsdMicros } from "@oxagen/billing";
import { searchUsageMeter } from "./search-usage";

const scope = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

const usage = (over: Partial<EmbedUsage> = {}): EmbedUsage => ({
  texts: ["refund a charge", "list invoices"],
  purpose: "document",
  tokens: 17,
  durationMs: 42,
  ...over,
});

class OutboxDown extends Error {
  override name = "OutboxDown";
}

/** A Voyage response with one vector per text and a token count. */
function answered(): HttpTransportResponse {
  const body = { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }], usage: { total_tokens: 17 } };
  return {
    status: 200,
    headers: [["content-type", "application/json"]],
    body: (async function* () {
      yield new TextEncoder().encode(JSON.stringify(body));
    })(),
    cancel: vi.fn(),
  };
}

function oxagenEmbedder(http: (request: unknown) => Promise<HttpTransportResponse>) {
  return httpEmbedder({
    url: "https://api.voyageai.com/v1/embeddings",
    model: "voyage-4-large",
    key: "a".repeat(32),
    apiKey: "voyage-test-key",
    inputType: true,
    meter: searchUsageMeter(scope, "voyage-4-large"),
    transport: { http },
  });
}

beforeEach(() => {
  mocks.admitUsage.mockResolvedValue("usage-1");
  mocks.finalizeUsage.mockResolvedValue(undefined);
  mocks.voidUsage.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.admitUsage.mockReset();
  mocks.finalizeUsage.mockReset();
  mocks.voidUsage.mockReset();
  mocks.scopes.length = 0;
});

describe("searchUsageMeter", () => {
  it("admits the request, then finalizes the admission with its tokens and no charge", async () => {
    const meter = await searchUsageMeter(scope, "voyage-4-large")();
    expect(mocks.admitUsage).toHaveBeenCalledWith(scope.orgId, scope.workspaceId);
    expect(mocks.finalizeUsage).not.toHaveBeenCalled();

    meter.used(usage());
    await vi.waitFor(() => expect(mocks.finalizeUsage).toHaveBeenCalled());

    expect(mocks.scopes).toEqual([scope, scope]);
    expect(mocks.finalizeUsage).toHaveBeenCalledTimes(1);
    const args = mocks.finalizeUsage.mock.calls[0]?.[0];
    expect(args).not.toHaveProperty("charge");
    expect(args).toMatchObject({
      id: "usage-1",
      complete: true,
      row: {
        execution_step_id: NIL_UUID,
        org_id: scope.orgId,
        workspace_id: scope.workspaceId,
        model: "voyage-4-large",
        provider: "voyage",
        input_tokens: 17,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd_micros: providerCostUsdMicros({ model: "voyage-4-large", inputTokens: 17, outputTokens: 0 }),
        duration_ms: 42,
        surface: "mcp",
        prompt_hash: await hashPrompt("refund a charge\nlist invoices"),
      },
    });
    expect(mocks.voidUsage).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("marks the row incomplete when the response gave no token count", async () => {
    const meter = await searchUsageMeter(scope, "voyage-4-large")();
    meter.used(usage({ tokens: null, purpose: "query", texts: ["refund"] }));
    await vi.waitFor(() => expect(mocks.finalizeUsage).toHaveBeenCalled());

    const args = mocks.finalizeUsage.mock.calls[0]?.[0];
    expect(args).toMatchObject({ complete: false, row: { input_tokens: 0 } });
  });

  it("voids the admission of a request that fails", async () => {
    const meter = await searchUsageMeter(scope, "voyage-4-large")();
    meter.failed();
    await vi.waitFor(() => expect(mocks.voidUsage).toHaveBeenCalled());

    expect(mocks.voidUsage).toHaveBeenCalledWith({
      id: "usage-1",
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      reason: "provider_call_failed",
    });
    expect(mocks.scopes).toEqual([scope, scope]);
    expect(mocks.finalizeUsage).not.toHaveBeenCalled();
  });

  it("lets search go on unmetered when the admission fails, and raises an alert", async () => {
    mocks.admitUsage.mockRejectedValue(new OutboxDown("connection refused to secret-host"));

    const meter = await searchUsageMeter(scope, "voyage-4-large")();
    meter.used(usage());
    meter.failed();

    expect(mocks.finalizeUsage).not.toHaveBeenCalled();
    expect(mocks.voidUsage).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const [fields, message] = mocks.error.mock.calls[0] ?? [];
    expect(fields).toEqual({
      workspaceId: scope.workspaceId,
      alert: "billing_search_usage_failed_open",
      errorName: "OutboxDown",
    });
    expect(JSON.stringify(fields)).not.toContain("secret-host");
    expect(message).toMatch(/not metered/);
  });

  it("logs a failed write by its name and never throws", async () => {
    mocks.finalizeUsage.mockRejectedValue(new OutboxDown("connection refused to secret-host"));

    const meter = await searchUsageMeter(scope, "voyage-4-large")();
    expect(() => meter.used(usage())).not.toThrow();
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = mocks.warn.mock.calls[0] ?? [];
    expect(fields).toEqual({ workspaceId: scope.workspaceId, errorName: "OutboxDown" });
    expect(JSON.stringify(fields)).not.toContain("secret-host");
    expect(message).toMatch(/not recorded/);
  });

  it("raises an alert when a failed request's admission cannot be voided", async () => {
    mocks.voidUsage.mockRejectedValue(new OutboxDown("connection refused to secret-host"));

    const meter = await searchUsageMeter(scope, "voyage-4-large")();
    expect(() => meter.failed()).not.toThrow();
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalled());

    const [fields] = mocks.error.mock.calls[0] ?? [];
    expect(fields).toEqual({
      workspaceId: scope.workspaceId,
      usageId: "usage-1",
      alert: "billing_usage_void_failed",
      errorName: "OutboxDown",
    });
  });
});

describe("the oxagen provider's embedder under searchUsageMeter", () => {
  it("admits before the provider call, and voids the admission when the call throws", async () => {
    const http = vi.fn(() => Promise.reject(new Error("socket hang up")));

    const error: unknown = await oxagenEmbedder(http)
      .embed(["refund a charge"], "query")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchIndexError);
    await vi.waitFor(() => expect(mocks.voidUsage).toHaveBeenCalled());

    const admitted = mocks.admitUsage.mock.invocationCallOrder[0] ?? Infinity;
    const sent = http.mock.invocationCallOrder[0] ?? -Infinity;
    expect(admitted).toBeLessThan(sent);
    expect(mocks.voidUsage).toHaveBeenCalledWith(expect.objectContaining({ id: "usage-1", reason: "provider_call_failed" }));
    expect(mocks.finalizeUsage).not.toHaveBeenCalled();
  });

  it("admits before the provider call, and finalizes the admission when the call answers", async () => {
    const http = vi.fn(() => Promise.resolve(answered()));

    const vectors = await oxagenEmbedder(http).embed(["refund a charge", "list invoices"], "document");
    expect(vectors).toHaveLength(2);
    await vi.waitFor(() => expect(mocks.finalizeUsage).toHaveBeenCalled());

    const admitted = mocks.admitUsage.mock.invocationCallOrder[0] ?? Infinity;
    const sent = http.mock.invocationCallOrder[0] ?? -Infinity;
    expect(admitted).toBeLessThan(sent);
    expect(mocks.finalizeUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "usage-1", complete: true, row: expect.objectContaining({ input_tokens: 17 }) }),
    );
    expect(mocks.voidUsage).not.toHaveBeenCalled();
  });
});
