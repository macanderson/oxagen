import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { workBriefApproveRoute } from "./work.brief.approve";

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
const DIGEST = `sha256:${"a".repeat(64)}`;
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const body = { item_id: ITEM, version: 4, item_revision: 1, brief_revision: 2, brief_digest: DIGEST };
const answer = { item: ITEM_AFTER, repeat: false };

function post(payload: string): Promise<Response> {
  return Promise.resolve(
    workBriefApproveRoute.fetch(
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

// POST /v1/:org_slug/:workspace_slug/work/items/brief/approve
describe("approve_work_brief route", () => {
  it("passes the parsed body to approve_work_brief on the API surface and answers 200", async () => {
    const res = await post(JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(mocks.invoke).toHaveBeenCalledWith("approve_work_brief", body, CTX, {
      surface: "api",
    });
  });

  it("refuses a body its contract does not accept before it invokes", async () => {
    const res = await post(JSON.stringify({ ...body, item_id: "wo_x" }));

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
