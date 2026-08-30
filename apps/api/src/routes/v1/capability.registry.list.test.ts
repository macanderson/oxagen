/**
 * Unit tests for GET /v1/:org/:ws/capability/registry/list.
 *
 * The route's job is query-param → contract-input mapping and forwarding to
 * invoke with { surface: "api" }; kernel + tenant seams are mocked.
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

import { capabilityRegistryListRoute } from "./capability.registry.list";

const fakeCtx = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = {
  capabilities: [],
  total: 0,
  hasMore: false,
  limit: 500,
  offset: 0,
  domains: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function get(qs = ""): Promise<Response> {
  return capabilityRegistryListRoute.fetch(
    new Request(`http://localhost/?${qs}`),
  );
}

describe("GET capability/registry/list", () => {
  it("applies contract defaults and forwards to invoke with surface api", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_capability_registry",
      { limit: 500, offset: 0 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("threads filters and coerces numeric params", async () => {
    await get(
      "domain=billing&q=usage&surface=mcp&missingLayer=app&sensitivity=high&limit=10&offset=20",
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_capability_registry",
      {
        domain: "billing",
        q: "usage",
        surface: "mcp",
        missingLayer: "app",
        sensitivity: "high",
        limit: 10,
        offset: 20,
      },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke on an invalid surface filter", async () => {
    const res = await get("surface=web");
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke on an out-of-bounds limit", async () => {
    const res = await get("limit=5000");
    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
