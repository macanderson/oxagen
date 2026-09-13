/**
 * Unit tests for GET /v1/:org/:ws/billing/actions/estimate.
 *
 * This is the only one of the four governed-action routes that parses real
 * input, so it is the only one where the adapter can get something wrong. A
 * query string is all strings; the contract wants numbers and enums. The
 * conversion happens here, and every way it can go wrong produces a wrong
 * PRICE rather than an error — which is why the undefined-versus-NaN cases
 * below are pinned rather than assumed.
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

import { billingActionEstimateRoute } from "./billing.action_estimate";

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
  assumptions: {
    runsPerYear: 1000,
    actionsPerRun: 15,
    actionsPerRunSource: "run_class",
    runClass: "standard_task",
    tier: "scale",
  },
  actionsPerYear: 15_000,
  includedActionsAnnual: 1_500_000,
  overageActions: 0,
  band: { id: "first-1m", usdPer1000: 20 },
  overageUsd: 0,
  excludes: "Excludes the platform fee and your own model tokens.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(qs: string): Promise<Response> {
  return billingActionEstimateRoute.fetch(new Request(`http://localhost/?${qs}`));
}

const inputOf = () =>
  mocks.invoke.mock.calls[0]![1] as Record<string, unknown>;

describe("GET billing/actions/estimate", () => {
  it("converts runs_per_year from a string to a number", async () => {
    const res = await get("runs_per_year=250000");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(inputOf().runsPerYear).toBe(250_000);
  });

  it("defaults the run class when none is given", async () => {
    await get("runs_per_year=1000");
    expect(inputOf().runClass).toBe("standard_task");
  });

  it("threads run_class, tier and a measured actions_per_run through", async () => {
    await get(
      "runs_per_year=1000&run_class=multi_step&actions_per_run=42&tier=enterprise",
    );
    expect(inputOf()).toMatchObject({
      runsPerYear: 1000,
      runClass: "multi_step",
      actionsPerRun: 42,
      tier: "enterprise",
    });
  });

  it("leaves an omitted actions_per_run undefined rather than sending NaN", async () => {
    // `Number(undefined)` is NaN, and a NaN actions-per-run would either fail
    // validation or silently price at the wrong ratio. The route guards the
    // conversion on presence, and this is the test that says so.
    await get("runs_per_year=1000");
    expect(inputOf().actionsPerRun).toBeUndefined();
    expect(Object.keys(inputOf())).not.toContain("NaN");
  });

  it("dispatches preview_action_cost with surface api", async () => {
    await get("runs_per_year=1000");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "preview_action_cost",
      expect.any(Object),
      fakeCtx,
      { surface: "api" },
    );
  });

  // The contract bounds and enums are the guard; the route must let them fire
  // rather than swallowing a bad value into a plausible quote.
  it("rejects a missing run volume instead of quoting from nothing", async () => {
    const res = await get("");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric run volume", async () => {
    // `Number("lots")` is NaN. A NaN that reached the handler would price a
    // quote off a number nobody typed, so the contract's bound has to fire and
    // the route has to let it.
    const res = await get("runs_per_year=lots");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects an unknown run class and an unknown tier", async () => {
    const badClass = await get("runs_per_year=1000&run_class=overnight");
    expect(badClass.status).toBeGreaterThanOrEqual(400);
    const badTier = await get("runs_per_year=1000&tier=platinum");
    expect(badTier.status).toBeGreaterThanOrEqual(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  // Hono catches a throw and turns it into a response; tested in isolation
  // there is no app-level `onError`, so that response is a bare 500. The
  // assertion is therefore on "not a success" rather than on an exact code —
  // the code is `apps/api/src/app.ts`'s job and is covered there. What matters
  // here is that a failure never leaves as a 200 with a plausible body.
  it("surfaces a handler failure rather than reporting success", async () => {
    mocks.invoke.mockRejectedValue(new Error("kernel exploded"));
    const res = await get("runs_per_year=1000");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
