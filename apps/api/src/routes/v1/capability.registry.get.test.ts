/**
 * Unit tests for GET /v1/:org/:ws/capability/registry/get.
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

import { capabilityRegistryGetRoute } from "./capability.registry.get";

const fakeCtx = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue({ capability: null });
});

async function get(qs = ""): Promise<Response> {
  return capabilityRegistryGetRoute.fetch(
    new Request(`http://localhost/?${qs}`),
  );
}

describe("GET capability/registry/get", () => {
  it("forwards the name to invoke with surface api", async () => {
    const res = await get("name=query_audit_log");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ capability: null });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_capability_registry",
      { name: "query_audit_log" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke when name is missing", async () => {
    const res = await get();
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
