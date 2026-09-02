/**
 * Unit tests for GET /v1/:org/:ws/iam/roles/list.
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

import { iamRoleListRoute } from "./iam.role.list";

const fakeCtx = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { roles: [], total: 0, hasMore: false, limit: 100, offset: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(qs = ""): Promise<Response> {
  return iamRoleListRoute.fetch(new Request(`http://localhost/?${qs}`));
}

describe("GET iam/roles/list", () => {
  it("applies contract defaults and forwards with surface api", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_iam_roles",
      { includeGrants: true, limit: 100, offset: 0 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("threads scopeKind and boolean/numeric params", async () => {
    await get("scopeKind=org&includeGrants=false&limit=5&offset=10");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_iam_roles",
      { scopeKind: "org", includeGrants: false, limit: 5, offset: 10 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke on an invalid scopeKind", async () => {
    const res = await get("scopeKind=global");
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
