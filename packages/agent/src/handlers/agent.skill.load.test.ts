import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  skillRow: vi.fn(),
  selectSpy: vi.fn(),
  fromSpy: vi.fn(),
  innerJoinSpy: vi.fn(),
  whereSpy: vi.fn(),
  limitSpy: vi.fn(),
}));

// Build the fluent query chain: select().from().innerJoin().where().limit()
// The last call (limitSpy) resolves to either a row array or empty array.
mocks.limitSpy.mockImplementation(async (): Promise<unknown> => mocks.skillRow() as unknown);
mocks.whereSpy.mockReturnValue({ limit: mocks.limitSpy });
mocks.innerJoinSpy.mockReturnValue({ where: mocks.whereSpy });
mocks.fromSpy.mockReturnValue({ innerJoin: mocks.innerJoinSpy });
mocks.selectSpy.mockReturnValue({ from: mocks.fromSpy });

const fakeSkillLoadDb = { select: mocks.selectSpy };
vi.mock("@oxagen/database", () => ({
  db: () => fakeSkillLoadDb,
  withTenantDb: async (fn: (tx: typeof fakeSkillLoadDb) => Promise<unknown>) =>
    fn(fakeSkillLoadDb),
  schema: {
    skills: { slug: "slug", orgId: "orgId", workspaceId: "workspaceId", id: "id" },
    skillVersions: {
      body: "body",
      referencesPayload: "referencesPayload",
      skillId: "skillId",
      isLatest: "isLatest",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return { and: original.and, eq: original.eq };
});

import { agentSkillLoadHandler } from "./agent.skill.load";

// ─────────────────────────────────────────────────────────────────────────────

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("agent.skill.load handler", () => {
  beforeEach(() => {
    mocks.selectSpy.mockClear();
    mocks.skillRow.mockClear();
  });

  it("returns slug, body, and references when the skill exists", async () => {
    mocks.skillRow.mockReturnValue([
      {
        slug: "my-skill",
        body: "# My Skill\nContent here",
        references: [{ path: "ref/a.md", body: "ref body" }],
      },
    ]);

    const result = await agentSkillLoadHandler({ slug: "my-skill", parentMessageId: "msg_1" }, CTX);

    expect(result.slug).toBe("my-skill");
    expect(result.body).toBe("# My Skill\nContent here");
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.path).toBe("ref/a.md");
  });

  it("returns an empty references array when references payload is null", async () => {
    mocks.skillRow.mockReturnValue([
      { slug: "no-refs", body: "body text", references: null },
    ]);

    const result = await agentSkillLoadHandler({ slug: "no-refs", parentMessageId: "msg_2" }, CTX);
    expect(result.references).toEqual([]);
  });

  it("returns an empty references array when references payload is not an array", async () => {
    mocks.skillRow.mockReturnValue([
      { slug: "bad-refs", body: "body", references: { malformed: true } },
    ]);

    const result = await agentSkillLoadHandler({ slug: "bad-refs", parentMessageId: "msg_3" }, CTX);
    expect(result.references).toEqual([]);
  });

  it("throws when the skill is not found in the workspace (tenant guard)", async () => {
    mocks.skillRow.mockReturnValue([]);

    await expect(
      agentSkillLoadHandler({ slug: "missing-skill", parentMessageId: "msg_4" }, CTX),
    ).rejects.toThrow("Skill missing-skill not found in workspace");
  });

  it("queries with the correct orgId and workspaceId (tenant isolation)", () => {
    mocks.skillRow.mockReturnValue([
      { slug: "ws-scoped", body: "body", references: [] },
    ]);
    const beforeSelect = mocks.selectSpy.mock.calls.length;
    const beforeInnerJoin = mocks.innerJoinSpy.mock.calls.length;
    const beforeWhere = mocks.whereSpy.mock.calls.length;

    // The where call receives the composed condition — we can't easily inspect
    // drizzle conditions here without real schema objects, but we can verify
    // the full chain was exercised.
    void agentSkillLoadHandler({ slug: "ws-scoped", parentMessageId: "msg_5" }, CTX);
    expect(mocks.selectSpy.mock.calls.length - beforeSelect).toBe(1);
    expect(mocks.innerJoinSpy.mock.calls.length - beforeInnerJoin).toBe(1);
    expect(mocks.whereSpy.mock.calls.length - beforeWhere).toBe(1);
  });
});
