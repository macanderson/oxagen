import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { skillVersionGetRoute } from "./skill.version.get";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { skill_id: "skl_1", version_id: "slv_1", content: "..." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("GET skill/version", () => {
  it("forwards the query params to invoke and returns the output", async () => {
    const res = await skillVersionGetRoute.fetch(
      new Request("http://localhost/?skill_id=skl_1&version_id=slv_1"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_skill_version",
      { skill_id: "skl_1", version_id: "slv_1" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("omits version_id when absent so the handler resolves the active version", async () => {
    await skillVersionGetRoute.fetch(
      new Request("http://localhost/?skill_id=skl_1"),
    );

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_skill_version",
      { skill_id: "skl_1", version_id: undefined },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("falls back to an empty string for skill_id when absent", async () => {
    await skillVersionGetRoute.fetch(
      new Request("http://localhost/?version_id=slv_1"),
    );

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_skill_version",
      { skill_id: "", version_id: "slv_1" },
      fakeCtx,
      { surface: "api" },
    );
  });
});
