import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { orgSettingsReadRoute } from "./org.settings.read";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: null,
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { name: "Acme", slug: "acme", avatarUrl: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("GET org/settings", () => {
  it("forwards an empty input to invoke and returns the output", async () => {
    const res = await orgSettingsReadRoute.fetch(
      new Request("http://localhost/"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith("get_org_settings", {}, fakeCtx, {
      surface: "api",
    });
  });
});
