import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
}));

mocks.selectWhere.mockResolvedValue([]);

const makeTx = () => ({
  select: () => ({
    from: () => ({
      where: mocks.selectWhere,
    }),
  }),
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx()),

  };
});

import { skillWorkspaceListHandler } from "./skill.workspace.list";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const makeSkillRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "skl_abc",
  name: "Summarize",
  description: "Summarizes documents",
  enabled: true,
  ...overrides,
});

describe("skillWorkspaceListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("returns empty skills array when no rows exist", async () => {
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result).toEqual({ skills: [] });
  });

  it("maps DB rows to contract output shape", async () => {
    mocks.selectWhere.mockResolvedValueOnce([makeSkillRow()]);
    const result = await skillWorkspaceListHandler({}, CTX);

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.id).toBe("skl_abc");
    expect(skill.name).toBe("Summarize");
    expect(skill.description).toBe("Summarizes documents");
    expect(skill.enabled).toBe(true);
  });

  it("coerces null description to empty string", async () => {
    mocks.selectWhere.mockResolvedValueOnce([makeSkillRow({ description: null })]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.description).toBe("");
  });

  it("returns disabled skill with enabled=false", async () => {
    mocks.selectWhere.mockResolvedValueOnce([makeSkillRow({ enabled: false })]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills[0]!.enabled).toBe(false);
  });

  it("returns multiple skills in order received", async () => {
    mocks.selectWhere.mockResolvedValueOnce([
      makeSkillRow({ publicId: "skl_1", name: "Skill A" }),
      makeSkillRow({ publicId: "skl_2", name: "Skill B", enabled: false }),
    ]);
    const result = await skillWorkspaceListHandler({}, CTX);
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]!.id).toBe("skl_1");
    expect(result.skills[1]!.id).toBe("skl_2");
  });

  it("invokes the query builder once (confirms tenant-scoped path)", async () => {
    await skillWorkspaceListHandler({}, CTX);
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
  });
});
