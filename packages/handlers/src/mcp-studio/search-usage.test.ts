/**
 * The token_usage row the oxagen provider's search embeddings write (lane M15;
 * ADR-217). These tests replace the usage outbox, the tenant scope, and the
 * logger, so they show the row's fields, that no credits are charged, and that
 * a failure is logged by name and never reaches search or publish.
 */
import type { EmbedUsage } from "@oxagen/mcp-studio";
import { hashPrompt, NIL_UUID } from "@oxagen/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitUsage: vi.fn(),
  finalizeUsage: vi.fn(),
  scopes: [] as unknown[],
  warn: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return { ...real, admitUsage: mocks.admitUsage, finalizeUsage: mocks.finalizeUsage };
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

vi.mock("../logger", () => ({ logger: { warn: mocks.warn, info: vi.fn() } }));

import { providerCostUsdMicros } from "@oxagen/billing";
import { searchUsageRecorder } from "./search-usage";

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

beforeEach(() => {
  mocks.admitUsage.mockResolvedValue("usage-1");
  mocks.finalizeUsage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.admitUsage.mockReset();
  mocks.finalizeUsage.mockReset();
  mocks.scopes.length = 0;
});

describe("searchUsageRecorder", () => {
  it("writes one token_usage row with the request's tokens and no charge", async () => {
    searchUsageRecorder(scope, "voyage-4-large")(usage());
    await vi.waitFor(() => expect(mocks.finalizeUsage).toHaveBeenCalled());

    expect(mocks.scopes).toEqual([scope]);
    expect(mocks.admitUsage).toHaveBeenCalledWith(scope.orgId, scope.workspaceId);
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
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("marks the row incomplete when the response gave no token count", async () => {
    searchUsageRecorder(scope, "voyage-4-large")(usage({ tokens: null, purpose: "query", texts: ["refund"] }));
    await vi.waitFor(() => expect(mocks.finalizeUsage).toHaveBeenCalled());

    const args = mocks.finalizeUsage.mock.calls[0]?.[0];
    expect(args).toMatchObject({ complete: false, row: { input_tokens: 0 } });
  });

  it("logs a failed write by its name and never throws", async () => {
    class OutboxDown extends Error {
      override name = "OutboxDown";
    }
    mocks.admitUsage.mockRejectedValue(new OutboxDown("connection refused to secret-host"));

    expect(() => searchUsageRecorder(scope, "voyage-4-large")(usage())).not.toThrow();
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());

    expect(mocks.finalizeUsage).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = mocks.warn.mock.calls[0] ?? [];
    expect(fields).toEqual({ workspaceId: scope.workspaceId, errorName: "OutboxDown" });
    expect(JSON.stringify(fields)).not.toContain("secret-host");
    expect(message).toMatch(/not recorded/);
  });
});
