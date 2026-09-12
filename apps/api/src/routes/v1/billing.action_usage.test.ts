/**
 * Unit tests for GET /v1/:org/:ws/billing/actions/usage.
 *
 * Tests the route in isolation: `invoke` (kernel) and `capabilityContext`
 * (tenant seam) are mocked so no auth middleware / DB / ClickHouse is needed.
 * The route's real job is to map the `include_breakdown` query param → the
 * contract's `includeBreakdown` boolean and forward to invoke with
 * { surface: "api" } — so that is what we assert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { billingActionUsageRoute } from "./billing.action_usage";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: "key_1",
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = {
  period: { start: "2026-01-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" },
  actionsUsed: 100,
  actionsIncluded: 500,
  actionsWithinAllowance: 100,
  actionsCharged: 0,
  actionsRemaining: 400,
  band: { id: "0-1m", usdPer1000: 5 },
  creditsCharged: 0,
  creditsAtFinalBand: 0,
  bandTrueUpCredits: 0,
  meterMode: "charge",
  modelSpend: {
    reportedCostMicros: 1_000_000,
    chargedCredits: 0,
    assistantTokenCredits: 0,
  },
  byCapability: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(qs = ""): Promise<Response> {
  return billingActionUsageRoute.fetch(new Request(`http://localhost/?${qs}`));
}

describe("GET billing/actions/usage", () => {
  it("forwards includeBreakdown=undefined (default false) when the query param is omitted", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_action_usage",
      { includeBreakdown: false },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("threads include_breakdown=true into the input", async () => {
    await get("include_breakdown=true");
    const input = mocks.invoke.mock.calls[0]![1] as {
      includeBreakdown: boolean;
    };
    expect(input.includeBreakdown).toBe(true);
  });

  it("threads include_breakdown=false explicitly into the input", async () => {
    await get("include_breakdown=false");
    const input = mocks.invoke.mock.calls[0]![1] as {
      includeBreakdown: boolean;
    };
    expect(input.includeBreakdown).toBe(false);
  });

  it("calls invoke with surface api and returns invoke's output verbatim", async () => {
    await get();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_action_usage",
      expect.any(Object),
      fakeCtx,
      { surface: "api" },
    );
  });
});
