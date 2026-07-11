import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { skillVersionListRoute } from "./skill.version.list";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { versions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("GET skill/version/list", () => {
  it("forwards skill_id alone, defaulting limit/offset per the contract", async () => {
    const res = await skillVersionListRoute.fetch(
      new Request("http://localhost/?skill_id=skl_1"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_skill_versions",
      { skill_id: "skl_1", limit: 20, offset: 0 },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("parses limit and offset query params to numbers", async () => {
    await skillVersionListRoute.fetch(
      new Request("http://localhost/?skill_id=skl_1&limit=5&offset=10"),
    );

    const input = mocks.invoke.mock.calls[0]![1] as {
      limit?: number;
      offset?: number;
    };
    expect(input.limit).toBe(5);
    expect(input.offset).toBe(10);
  });

  it("falls back to an empty string when skill_id is absent", async () => {
    await skillVersionListRoute.fetch(new Request("http://localhost/"));

    const input = mocks.invoke.mock.calls[0]![1] as { skill_id: string };
    expect(input.skill_id).toBe("");
  });
});
