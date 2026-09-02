import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  queryResult: vi.fn(),
  whereMock: vi.fn(),
  leftJoinMock: vi.fn(),
  fromMock: vi.fn(),
  selectMock: vi.fn(),
}));

// Build a minimal chain: select → from → leftJoin → where → (returns result)
mocks.whereMock.mockImplementation(
  async (): Promise<unknown> => mocks.queryResult() as unknown,
);
mocks.leftJoinMock.mockReturnValue({ where: mocks.whereMock });
mocks.fromMock.mockReturnValue({ leftJoin: mocks.leftJoinMock });
mocks.selectMock.mockReturnValue({ from: mocks.fromMock });

const fakeSkillListDb = { select: mocks.selectMock };
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeSkillListDb,
    withTenantDb: async (
      fn: (tx: typeof fakeSkillListDb) => Promise<unknown>,
    ) => fn(fakeSkillListDb),
  };
});

import { agentSkillListHandler } from "./agent.skill.list";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

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
      {
        slug: "summarize",
        name: "Summarize",
        description: "Summarizes text",
        source: "builtin",
        version: 3,
      },
      {
        slug: "custom-one",
        name: "Custom One",
        description: null,
        source: "tenant",
        version: null,
      },
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

// ── Agent RBAC skills.slugs index filter (spec §3.3, Phase 4b) ─────────────────

describe("agent.skill.list — role scope index filter", () => {
  function agentCtx(slugs: string[] | undefined) {
    const byCapability = new Map<string, unknown>();
    byCapability.set("list_agent_skills", {
      outcome: "allow",
      agentResolution: {},
      humanResolution: {},
      resourceScope: { skills: slugs === undefined ? {} : { slugs } },
    });
    return {
      ...CTX,
      agentRun: {
        agentPrincipal: {
          id: "prn_agent",
          kind: "agent",
          orgId: CTX.orgId,
          workspaceId: CTX.workspaceId,
        },
        humanPrincipal: null,
        agentId: "agt_1",
        runId: "run_1",
        resolution: { byCapability },
      },
    } as typeof CTX;
  }

  it("returns an empty index for an empty allow-list without querying", async () => {
    const beforeWhere = mocks.whereMock.mock.calls.length;
    const result = await agentSkillListHandler({}, agentCtx([]));
    expect(result.skills).toEqual([]);
    expect(mocks.whereMock.mock.calls.length - beforeWhere).toBe(0);
  });

  it("adds a slug filter condition when the allow-list is constrained", async () => {
    mocks.queryResult.mockReturnValue([
      {
        slug: "allowed",
        name: "Allowed",
        description: "",
        source: "tenant",
        version: 1,
      },
    ]);
    const result = await agentSkillListHandler({}, agentCtx(["allowed"]));
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.slug).toBe("allowed");
  });

  it("leaves the index unfiltered when slugs is undefined (all workspace skills)", async () => {
    mocks.queryResult.mockReturnValue([
      { slug: "a", name: "A", description: "", source: "builtin", version: 1 },
      { slug: "b", name: "B", description: "", source: "tenant", version: 2 },
    ]);
    const result = await agentSkillListHandler({}, agentCtx(undefined));
    expect(result.skills).toHaveLength(2);
  });
});
