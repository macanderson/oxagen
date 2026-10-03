import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { workCriterionClaimRoute } from "./work.criterion.claim";

const CTX = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: null,
  apiKeyId: "aky_host",
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};
const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const SHA = "a1".repeat(20);
const body = {
  item_id: ITEM,
  work_order_id: ORDER,
  criterion_id: "c1",
  head_sha: SHA,
  text: "The invite test covers the expired link.",
};
const answer = {
  item: { id: ITEM, state: "review", revision: 1, version: 5 },
  repeat: false,
  order: { id: ORDER, send: 1, key: `${ITEM}:r1:s1`, delivery: "run_ended" },
  claim: { criterion_id: "c1", head_sha: SHA, run_id: "tse_0a1b2c" },
};

function post(payload: string): Promise<Response> {
  return Promise.resolve(
    workCriterionClaimRoute.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue(CTX);
  mocks.invoke.mockResolvedValue(answer);
});

// POST /v1/:org_slug/:workspace_slug/work/orders/criteria/claim
describe("claim_work_criterion route", () => {
  it("passes the parsed body to claim_work_criterion on the API surface and answers 200", async () => {
    const res = await post(JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(mocks.invoke).toHaveBeenCalledWith("claim_work_criterion", body, CTX, {
      surface: "api",
    });
  });

  it("refuses a body its contract does not accept before it invokes", async () => {
    const res = await post(JSON.stringify({ ...body, criterion_id: "criterion-1" }));

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
