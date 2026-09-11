/**
 * Unit tests for GET /v1/:org/:ws/billing/actions/rate-card.
 *
 * The route is a thin adapter, so the assertions are about the adapter's only
 * job: build the context, dispatch through the kernel with `surface: "api"`,
 * and return the handler's output untouched. `invoke` and `capabilityContext`
 * are mocked, so no auth middleware, DB or ClickHouse is involved.
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

import { billingActionRateCardRoute } from "./billing.action_rate_card";

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
  unit: "governed_action",
  summary: "Governed actions are the billable unit.",
  bands: [
    {
      id: "first-1m",
      minAnnualActions: 0,
      maxAnnualActions: 1_000_000,
      usdPer1000: 20,
    },
  ],
  tiers: [
    { tier: "enterprise", includedActionsAnnual: null, retentionMonths: 12 },
  ],
  retention: { includedMonths: 12, usdPerGbMonth: 0.08, optIn: true },
  modelTokens: { usdPerToken: 0, explanation: "Reported, charged at zero." },
  yourTier: "scale",
  yourIncludedActionsAnnual: 1_500_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(qs = ""): Promise<Response> {
  return billingActionRateCardRoute.fetch(new Request(`http://localhost/?${qs}`));
}

describe("GET billing/actions/rate-card", () => {
  it("dispatches get_rate_card with an empty input and surface api", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledWith("get_rate_card", {}, fakeCtx, {
      surface: "api",
    });
  });

  it("returns the handler's output verbatim", async () => {
    const res = await get();
    // Including the deliberate zero on model tokens: an adapter that dropped or
    // reshaped that line would hide the thing ADR-052 wants a buyer to see.
    expect(await res.json()).toEqual(OUTPUT);
  });

  it("ignores unexpected query parameters rather than forwarding them", async () => {
    // The contract's input is an empty object, so anything on the query string
    // is noise. Forwarding it would fail the kernel's input validation on a
    // request that is otherwise perfectly valid.
    await get("tier=enterprise&nonsense=1");
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({});
  });

  // Hono catches a throw and turns it into a response; tested in isolation
  // there is no app-level `onError`, so that response is a bare 500. The
  // assertion is therefore on "not a success" rather than on an exact code —
  // the code is `apps/api/src/app.ts`'s job and is covered there. What matters
  // here is that a failure never leaves as a 200 with a plausible body.
  it("surfaces a handler failure rather than reporting success", async () => {
    mocks.invoke.mockRejectedValue(new Error("kernel exploded"));
    const res = await get();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
