/**
 * billing.usage.breakdown handler tests
 *
 * Strategy: stub @oxagen/telemetry.readUsageBreakdown so no live ClickHouse is
 * required. Assert the tenant boundary (ctx.orgId, never the input), the
 * threading of input.workspaceId, date coercion, and the echoed range/output.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ readUsageBreakdown: vi.fn() }));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, readUsageBreakdown: mocks.readUsageBreakdown };
});

import { billingUsageBreakdownHandler } from "./billing.usage.breakdown";
import { TEST_CTX } from "./test-utils/fixtures";

const BREAKDOWN = {
  totals: {
    inputTokens: 100,
    outputTokens: 40,
    cachedTokens: 10,
    cacheWriteTokens: 20,
    costMicros: 5000,
    executions: 3,
    messages: 2,
  },
  series: [
    {
      day: "2026-06-01",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      cacheWriteTokens: 20,
      costMicros: 5000,
      executions: 3,
      messages: 2,
    },
  ],
  byModel: [
    {
      key: "claude-sonnet-5",
      provider: "anthropic",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      cacheWriteTokens: 20,
      costMicros: 5000,
      executions: 3,
      messages: 2,
    },
  ],
  bySurface: [
    {
      key: "api",
      provider: "",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      cacheWriteTokens: 20,
      costMicros: 5000,
      executions: 3,
      messages: 2,
    },
  ],
  byWorkspace: [
    {
      key: "ws-a",
      provider: "",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      cacheWriteTokens: 20,
      costMicros: 5000,
      executions: 3,
      messages: 2,
    },
  ],
  byCapability: [
    {
      key: "query_ontology",
      provider: "",
      inputTokens: 60,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 10,
      costMicros: 3000,
      executions: 2,
      messages: 1,
    },
  ],
  byPrincipal: [
    {
      principalId: "00000000-0000-0000-0000-0000000000e5",
      principalKind: "agent",
      inputTokens: 60,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 10,
      costMicros: 3000,
      executions: 2,
      messages: 1,
    },
  ],
  byUser: [
    {
      userId: "00000000-0000-0000-0000-0000000000e5",
      inputTokens: 60,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 10,
      costMicros: 3000,
      executions: 2,
      messages: 1,
    },
  ],
};

const INPUT = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readUsageBreakdown.mockResolvedValue(BREAKDOWN);
});

describe("billingUsageBreakdownHandler (@oxagen/handlers)", () => {
  it("scopes the read to ctx.orgId and echoes the range + breakdown", async () => {
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);

    const arg = mocks.readUsageBreakdown.mock.calls[0]![0];
    expect(arg.orgId).toBe(TEST_CTX.orgId);
    expect(arg.workspaceId).toBeUndefined();
    expect(arg.start).toEqual(new Date(INPUT.start));
    expect(arg.end).toEqual(new Date(INPUT.end));

    expect(out.range).toEqual({ start: INPUT.start, end: INPUT.end });
    expect(out.totals).toEqual(BREAKDOWN.totals);
    expect(out.byModel).toEqual(BREAKDOWN.byModel);
    expect(out.bySurface).toEqual(BREAKDOWN.bySurface);
    expect(out.byWorkspace).toEqual(BREAKDOWN.byWorkspace);
    expect(out.byCapability).toEqual(BREAKDOWN.byCapability);
    expect(out.byPrincipal).toEqual(BREAKDOWN.byPrincipal);
    expect(out.byUser).toEqual(BREAKDOWN.byUser);
    expect(out.series).toEqual(BREAKDOWN.series);
  });

  it("estimates net cache savings from byModel using the provider rate card (#1076)", async () => {
    // claude-sonnet-5 rate: input $3, cachedInput $0.3, cacheWrite $3.75 per 1M.
    // reads saved  = 10 × (3.0 − 0.3)  = 27 micro-USD
    // writes cost  = 20 × (3.75 − 3.0) = 15 micro-USD
    // net savings  = 27 − 15 = 12 micro-USD
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);
    expect(out.cacheSavingsMicros).toBe(12);
  });

  it("reports zero cache savings when no tokens were cached", async () => {
    mocks.readUsageBreakdown.mockResolvedValueOnce({
      ...BREAKDOWN,
      byModel: [
        {
          ...BREAKDOWN.byModel[0],
          cachedTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);
    expect(out.cacheSavingsMicros).toBe(0);
  });

  it("threads input.workspaceId to narrow within the org", async () => {
    const wsId = "22222222-2222-2222-2222-222222222222";
    await billingUsageBreakdownHandler(
      { ...INPUT, workspaceId: wsId },
      TEST_CTX,
    );
    const arg = mocks.readUsageBreakdown.mock.calls[0]![0];
    expect(arg.orgId).toBe(TEST_CTX.orgId);
    expect(arg.workspaceId).toBe(wsId);
  });

  it("propagates ClickHouse errors (no silent zeros)", async () => {
    mocks.readUsageBreakdown.mockRejectedValue(new Error("clickhouse down"));
    await expect(billingUsageBreakdownHandler(INPUT, TEST_CTX)).rejects.toThrow(
      "clickhouse down",
    );
  });
});
