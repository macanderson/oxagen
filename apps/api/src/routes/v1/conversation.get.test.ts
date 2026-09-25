import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { conversationGetRoute } from "./conversation.get";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { conversation: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

const get = (path: string) =>
  conversationGetRoute.fetch(new Request(`http://localhost${path}`));

describe("GET conversations/:conversationId", () => {
  it("reads the latest active conversation on `latest`", async () => {
    const res = await get("/latest");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_conversation",
      { conversationId: null, limit: 100 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("reads a named conversation with the limit it was given", async () => {
    await get("/cnv_01k9x2?limit=20");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_conversation",
      { conversationId: "cnv_01k9x2", limit: 20 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("refuses an id that is not a cnv_ public id before invoking (negative)", async () => {
    // The app's error middleware answers the parse failure; mounted alone the
    // route answers Hono's default, and either way nothing is read.
    const res = await get("/0192d4a8-7c1e-7a00-8000-0000000000c1");
    expect(res.ok).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
