import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { toolRelayRevokeRoute } from "./tool.relay.revoke";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = {
  publicId: "rly_0123456789abcdefghjkmn",
  name: "office-lan",
  revokedAt: "2026-09-28T18:05:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function post(body: string): Promise<Response> {
  return toolRelayRevokeRoute.fetch(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("POST tools/relays/revoke", () => {
  it("invokes revoke_relay on the api surface and answers the revoked relay with 200", async () => {
    const res = await post(JSON.stringify({ name: "office-lan" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "revoke_relay",
      { name: "office-lan" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke without a name (negative)", async () => {
    const res = await post(JSON.stringify({}));

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke for a public id in place of a name (negative)", async () => {
    const res = await post(
      JSON.stringify({ name: "rly_0123456789abcdefghjkmn" }),
    );

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke when the body names a workspace, since the scope is the URL's (negative)", async () => {
    const res = await post(
      JSON.stringify({ name: "office-lan", workspaceId: "other" }),
    );

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON (negative)", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
