/**
 * Unit tests for GET /v1/:org/:ws/billing/evidence/retention.
 *
 * Thin adapter, so the assertions are about dispatch and pass-through. The one
 * output detail worth pinning here is that a null `storedGbBeyondIncluded`
 * survives serialisation as null: "not measured" and "zero" are different
 * claims, and an adapter that coerced one into the other would make the API
 * assert something the handler deliberately refused to.
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

import { billingEvidenceRetentionRoute } from "./billing.evidence_retention";

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
  includedMonths: 12,
  effectiveRetentionDays: null,
  extendedRetentionEnabled: false,
  usdPerGbMonth: 0.08,
  storedGbBeyondIncluded: null,
  storedGbMeasured: false,
  creditsChargedThisPeriod: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(): Promise<Response> {
  return billingEvidenceRetentionRoute.fetch(new Request("http://localhost/"));
}

describe("GET billing/evidence/retention", () => {
  it("dispatches get_evidence_retention with an empty input and surface api", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_evidence_retention",
      {},
      fakeCtx,
      { surface: "api" },
    );
  });

  it("keeps an unmeasured volume as null rather than coercing it to zero", async () => {
    const body = (await (await get()).json()) as typeof OUTPUT;
    expect(body.storedGbBeyondIncluded).toBeNull();
    expect(body.storedGbMeasured).toBe(false);
  });

  it("passes a measured zero through as zero, which is a different claim", async () => {
    mocks.invoke.mockResolvedValue({
      ...OUTPUT,
      storedGbBeyondIncluded: 0,
      storedGbMeasured: true,
    });
    const body = (await (await get()).json()) as typeof OUTPUT;
    expect(body.storedGbBeyondIncluded).toBe(0);
    expect(body.storedGbMeasured).toBe(true);
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
