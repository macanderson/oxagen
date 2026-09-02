/**
 * Unit tests for GET /v1/:org/:ws/billing/usage/breakdown.
 *
 * Tests the route in isolation: `invoke` (kernel) and `capabilityContext`
 * (tenant seam) are mocked so no auth middleware / DB / ClickHouse is needed.
 * The route's real job is to map query params → the contract input and forward
 * to invoke with { surface: "api" } — so that is what we assert, plus that the
 * contract's own validation rejects a malformed window.
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

import { billingUsageBreakdownRoute } from "./billing.usage.breakdown";

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
  range: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costMicros: 0,
    executions: 0,
  },
  series: [],
  byModel: [],
  bySurface: [],
  byWorkspace: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(qs: string): Promise<Response> {
  return billingUsageBreakdownRoute.fetch(
    new Request(`http://localhost/?${qs}`),
  );
}

describe("GET billing/usage/breakdown", () => {
  it("forwards the parsed window to invoke with surface api and returns the output", async () => {
    const res = await get(
      "start=2026-06-01T00:00:00.000Z&end=2026-07-01T00:00:00.000Z",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_usage_breakdown",
      {
        start: "2026-06-01T00:00:00.000Z",
        end: "2026-07-01T00:00:00.000Z",
        workspaceId: undefined,
      },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("threads the workspace_id query param into the input", async () => {
    await get(
      "start=2026-06-01T00:00:00.000Z&end=2026-07-01T00:00:00.000Z&workspace_id=22222222-2222-2222-2222-222222222222",
    );
    const input = mocks.invoke.mock.calls[0]![1] as { workspaceId?: string };
    expect(input.workspaceId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("does not invoke when the window is invalid (end before start)", async () => {
    const res = await get(
      "start=2026-07-01T00:00:00.000Z&end=2026-06-01T00:00:00.000Z",
    );
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke when a bound is missing", async () => {
    const res = await get("start=2026-06-01T00:00:00.000Z");
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
