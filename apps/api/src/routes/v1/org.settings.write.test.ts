import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { orgSettingsWriteRoute } from "./org.settings.write";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: null,
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { name: "Acme Inc.", slug: "acme", avatarUrl: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

async function patch(body: unknown): Promise<Response> {
  return orgSettingsWriteRoute.fetch(
    new Request("http://localhost/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH org/settings", () => {
  it("forwards the parsed body to invoke and returns the output", async () => {
    const res = await patch({ name: "Acme Inc." });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_org_settings",
      { name: "Acme Inc." },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("does not invoke when the body fails contract validation", async () => {
    const res = await patch({ slug: "Not A Valid Slug!" });

    expect(res.status).not.toBe(200);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
