import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  queryResult: vi.fn(),
  whereMock: vi.fn(),
  leftJoinMock: vi.fn(),
  fromMock: vi.fn(),
  selectMock: vi.fn(),
}));

// Build a minimal chain: select → from → leftJoin → where → (returns result)
mocks.whereMock.mockImplementation(async (): Promise<unknown> => mocks.queryResult() as unknown);
mocks.leftJoinMock.mockReturnValue({ where: mocks.whereMock });
mocks.fromMock.mockReturnValue({ leftJoin: mocks.leftJoinMock });
mocks.selectMock.mockReturnValue({ from: mocks.fromMock });

vi.mock("@oxagen/database", () => ({
  db: () => ({ select: mocks.selectMock }),
  schema: {
    skills: {
      orgId: "orgId",
      workspaceId: "workspaceId",
      id: "id",
      slug: "slug",
      name: "name",
      description: "description",
      source: "source",
    },
    skillVersions: {
      skillId: "skillId",
      isLatest: "isLatest",
      versionNumber: "versionNumber",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { and: orig.and, eq: orig.eq, ilike: orig.ilike };
});

import { agentSkillListHandler } from "./agent.skill.list";

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("agent.skill.list handler", () => {
  beforeEach(() => {
    mocks.selectMock.mockClear();
    mocks.queryResult.mockClear();
  });

  it("returns an empty skill list when no rows exist", async () => {
    mocks.queryResult.mockReturnValueOnce([]);
    const result = await agentSkillListHandler({}, CTX);
    expect(result.skills).toEqual([]);
  });

  it("maps rows to the expected output shape", async () => {
    mocks.queryResult.mockReturnValueOnce([
      { slug: "summarize", name: "Summarize", description: "Summarizes text", source: "builtin", version: 3 },
      { slug: "custom-one", name: "Custom One", description: null, source: "tenant", version: null },
    ]);
    const result = await agentSkillListHandler({}, CTX);
    expect(result.skills).toHaveLength(2);
    const [first, second] = result.skills;
    expect(first!.slug).toBe("summarize");
    expect(first!.source).toBe("builtin");
    expect(first!.version).toBe("3");
    expect(second!.description).toBe("");
    expect(second!.source).toBe("tenant");
    expect(second!.version).toBe("1"); // fallback when version is null
  });

  it("applies ilike filter when input.filter is provided", async () => {
    mocks.queryResult.mockReturnValueOnce([]);
    const beforeWhere = mocks.whereMock.mock.calls.length;
    await agentSkillListHandler({ filter: "sum" }, CTX);
    expect(mocks.whereMock.mock.calls.length - beforeWhere).toBe(1);
  });

  it("scopes query to orgId and workspaceId from context (tenant isolation)", async () => {
    mocks.queryResult.mockReturnValue([]);
    const beforeWhere = mocks.whereMock.mock.calls.length;
    await agentSkillListHandler({}, CTX);
    expect(mocks.whereMock.mock.calls.length - beforeWhere).toBe(1);
  });
});
