import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { toolRelayCreateRoute } from "./tool.relay.create";

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
  createdAt: "2026-09-28T18:00:00.000Z",
  token: "oxr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function post(body: string): Promise<Response> {
  return toolRelayCreateRoute.fetch(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("POST tools/relays", () => {
  it("invokes create_relay on the api surface and answers the relay and its token with 201", async () => {
    const res = await post(JSON.stringify({ name: "office-lan" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_relay",
      { name: "office-lan" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke without a name (negative)", async () => {
    const res = await post(JSON.stringify({}));

    expect(res.status).not.toBe(201);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each(["Office", "-office", "office_lan", `a${"b".repeat(63)}`])(
    "does not invoke for the name %j, which the broker cannot route (negative)",
    async (name) => {
      const res = await post(JSON.stringify({ name }));

      expect(res.status).not.toBe(201);
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );

  it("does not invoke when the body names a workspace, since the scope is the URL's (negative)", async () => {
    const res = await post(
      JSON.stringify({ name: "office-lan", workspaceId: "other" }),
    );

    expect(res.status).not.toBe(201);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON (negative)", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
