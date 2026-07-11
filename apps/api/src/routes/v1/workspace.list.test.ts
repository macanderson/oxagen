import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { workspaceListRoute } from "./workspace.list";

const fakeCtx = {
  orgId: null,
  workspaceId: null,
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { workspaces: [{ id: "w1", slug: "default", name: "Default" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function post(body: unknown): Promise<Response> {
  return workspaceListRoute.fetch(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST workspace/list", () => {
  it("forwards the parsed body to invoke without requiring an org context", async () => {
    const res = await post({ orgSlug: "acme" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.capabilityContext).toHaveBeenCalledWith(expect.anything(), {
      requireOrg: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_workspaces",
      { orgSlug: "acme" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke when orgSlug is missing", async () => {
    const res = await post({});

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
