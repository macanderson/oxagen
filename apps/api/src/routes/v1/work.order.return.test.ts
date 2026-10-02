import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { workOrderReturnRoute } from "./work.order.return";

const CTX = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};
const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const ORDER_AFTER = { id: ORDER, send: 1, key: `${ITEM}:r1:s1`, delivery: "run_ended" };
const body = { item_id: ITEM, version: 7, work_order_id: ORDER, reason: "The test does not cover the empty name." };
const answer = {
  item: { ...ITEM_AFTER, state: "sent" },
  repeat: false,
  order: { ...ORDER_AFTER, delivery: "returned" },
  resent: { ...ORDER_AFTER, send: 2, key: `${ITEM}:r1:s2`, delivery: "waiting_for_claim" },
  resend_refused: null,
};

function post(payload: string): Promise<Response> {
  return Promise.resolve(
    workOrderReturnRoute.fetch(
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

// POST /v1/:org_slug/:workspace_slug/work/orders/return
describe("return_work_order route", () => {
  it("passes the parsed body to return_work_order on the API surface and answers 200", async () => {
    const res = await post(JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(mocks.invoke).toHaveBeenCalledWith("return_work_order", { ...body, resend: true }, CTX, {
      surface: "api",
    });
  });

  it("refuses a body its contract does not accept before it invokes", async () => {
    const res = await post(JSON.stringify({ ...body, resend: "no" }));

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
