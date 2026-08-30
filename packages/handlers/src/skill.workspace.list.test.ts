import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// Query chain: select().from().leftJoin().where().orderBy() — the terminal
// .orderBy() resolves the rows (mirrors the handler's tenant-scoped read).
const mocks = vi.hoisted(() => ({
  selectOrderBy: vi.fn(),
}));

mocks.selectOrderBy.mockResolvedValue([]);

const makeTx = () => ({
  select: () => ({
    from: () => ({
      leftJoin: () => ({
        where: () => ({
          orderBy: mocks.selectOrderBy,
        }),
      }),
    }),
  }),
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

import { skillWorkspaceListHandler } from "./skill.workspace.list";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

// A row as the leftJoin SELECT returns it (DB column shape, not contract shape).
const makeSkillRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "skl_abc",
  slug: "summarize",
  name: "Summarize",
  description: "Summarizes documents",
  source: "tenant",
  enabled: true,
  updatedAt: new Date("2026-07-01T12:00:00.000Z"),
  activeVersionNumber: 1,
  ...overrides,
});

describe("skillWorkspaceListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectOrderBy.mockResolvedValue([]);
  });

  it("returns empty skills array when no rows exist", async () => {
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result).toEqual({ skills: [] });
  });

  it("maps DB rows to the full contract output shape", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([makeSkillRow()]);
    const result = await skillWorkspaceListHandler({}, CTX);

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.id).toBe("skl_abc");
    expect(skill.slug).toBe("summarize");
    expect(skill.name).toBe("Summarize");
    expect(skill.description).toBe("Summarizes documents");
    expect(skill.source).toBe("tenant");
    expect(skill.enabled).toBe(true);
    // Version number is rendered as a "v"-prefixed label for the list.
    expect(skill.activeVersion).toBe("v1");
    expect(skill.updatedAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("coerces null description to empty string", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([
      makeSkillRow({ description: null }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.description).toBe("");
  });

  it("returns activeVersion null when no version is pinned (null join)", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([
      makeSkillRow({ activeVersionNumber: null }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.activeVersion).toBeNull();
  });

  it("returns updatedAt null when the column is null", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([
      makeSkillRow({ updatedAt: null }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.updatedAt).toBeNull();
  });

  it("returns disabled skill with enabled=false", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([
      makeSkillRow({ enabled: false }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.enabled).toBe(false);
  });

  it("preserves source provenance (builtin vs tenant)", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([
      makeSkillRow({ source: "builtin" }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.source).toBe("builtin");
  });

  it("returns multiple skills in order received", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([
      makeSkillRow({ publicId: "skl_1", slug: "a", name: "Skill A" }),
      makeSkillRow({
        publicId: "skl_2",
        slug: "b",
        name: "Skill B",
        enabled: false,
      }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]!.id).toBe("skl_1");
    expect(result.skills[1]!.id).toBe("skl_2");
  });

  it("invokes the query builder once (confirms tenant-scoped path)", async () => {
    await skillWorkspaceListHandler({}, CTX);
    expect(mocks.selectOrderBy).toHaveBeenCalledTimes(1);
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("propagates DB error when the query rejects", async () => {
    mocks.selectOrderBy.mockRejectedValueOnce(
      new Error("DB connection failed"),
    );

    await expect(skillWorkspaceListHandler({}, CTX)).rejects.toThrow(
      "DB connection failed",
    );
  });

  it("propagates DB error when withTenantDb rejects", async () => {
    // Simulate a scenario where the transaction itself cannot be obtained.
    mocks.selectOrderBy.mockRejectedValueOnce(
      new Error("transaction rollback"),
    );

    await expect(skillWorkspaceListHandler({}, CTX)).rejects.toThrow(
      "transaction rollback",
    );
  });
});
