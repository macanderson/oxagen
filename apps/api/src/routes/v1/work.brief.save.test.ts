import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), context: vi.fn() }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({ capabilityContext: mocks.context }));

import { workBriefSaveRoute } from "./work.brief.save";

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
const body = {
  item_id: ITEM,
  version: 3,
  item_revision: 1,
  repository: "acme/platform",
  criteria: [{ text: "The settings page saves the new name.", tag: "code", intent: "check", provenance: "person" }],
};
const answer = { item: ITEM_AFTER, repeat: false, brief: { revision: 2, digest: DIGEST } };

function post(payload: string): Promise<Response> {
  return Promise.resolve(
    workBriefSaveRoute.fetch(
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

// POST /v1/:org_slug/:workspace_slug/work/items/brief/save
describe("save_work_brief route", () => {
  it("passes the parsed body to save_work_brief on the API surface and answers 200", async () => {
    const res = await post(JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(mocks.invoke).toHaveBeenCalledWith("save_work_brief", body, CTX, {
      surface: "api",
    });
  });

  it("refuses a body its contract does not accept before it invokes", async () => {
    const res = await post(JSON.stringify({ ...body, criteria: [{ ...body.criteria[0], id: "x1" }] }));

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
