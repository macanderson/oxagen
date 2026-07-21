import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// skill.edit delegates to createNewSkillVersion, which inside one withTenantDb
// transaction: looks up the skill, finds the max version, loads the prior
// latest row (lineage + carried-forward references), clears its is_latest
// (update #1, only when a prior latest exists), inserts the new version, and
// ONLY when activate=true updates the skills row (update #2). We route the two
// updates to separate spies by table identity so the "does NOT update
// active_version_id when activate=false" assertion targets the skills update.
const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
  selectMaxWhere: vi.fn(),
  selectPriorLatestWhere: vi.fn(),
  insertReturning: vi.fn(),
  versionUpdateWhere: vi.fn(),
  skillUpdateWhere: vi.fn(),
  insertedValues: [] as Record<string, unknown>[],
}));

const VALID_CONTENT = `schema_version = 1
kind = "skill"
name = "edited-skill"
description = "An edited skill"
instructions = "Updated skill instructions."
references = []
`;

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const { skills } = real.schema;

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      let selectCallCount = 0;
      return fn({
        select: (_fields: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond: unknown) => {
              selectCallCount++;
              if (selectCallCount === 1) return mocks.selectWhere();
              if (selectCallCount === 2) return mocks.selectMaxWhere();
              // 3rd: prior-latest lookup — chains .limit(1)
              return { limit: (_n: number) => mocks.selectPriorLatestWhere() };
            },
          }),
        }),
        insert: (_table: unknown) => ({
          values: (vals: unknown) => {
            mocks.insertedValues.push(vals as Record<string, unknown>);
            return { returning: mocks.insertReturning };
          },
        }),
        update: (table: unknown) => ({
          set: (_vals: unknown) => ({
            where:
              table === skills
                ? mocks.skillUpdateWhere
                : mocks.versionUpdateWhere,
          }),
        }),
      });
    },
  };
});

import { skillEditHandler } from "./skill.edit";
import { makeCTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const SKILL_ROW = { id: "skill-uuid-edit", publicId: "skl_edit" };
const VERSION_ROW = {
  id: "ver-uuid-e1",
  publicId: "slv_edit1",
  versionNumber: 3,
};

function setupHappyPath(
  overrides: Partial<{
    skill_id: string;
    content: string;
    activate: boolean;
  }> = {},
) {
  mocks.selectWhere.mockReset();
  mocks.selectMaxWhere.mockReset();
  mocks.selectPriorLatestWhere.mockReset();
  mocks.insertReturning.mockReset();
  mocks.versionUpdateWhere.mockReset();
  mocks.skillUpdateWhere.mockReset();
  mocks.insertedValues.length = 0;

  mocks.selectWhere.mockResolvedValue([SKILL_ROW]);
  mocks.selectMaxWhere.mockResolvedValue([{ maxVersion: 2 }]);
  mocks.selectPriorLatestWhere.mockResolvedValue([
    { id: "ver-uuid-e0", referencesPayload: [] },
  ]);
  mocks.insertReturning.mockResolvedValue([VERSION_ROW]);
  mocks.versionUpdateWhere.mockResolvedValue([]);
  mocks.skillUpdateWhere.mockResolvedValue([]);

  return {
    skill_id: "skl_edit",
    content: VALID_CONTENT,
    activate: true,
    workspace_id: undefined as string | undefined,
    ...overrides,
  };
}

const CTX = makeCTX({ userId: "u_editor" });

describe("skillEditHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct shape on success", async () => {
    const input = setupHappyPath();
    const result = await skillEditHandler(input, CTX);

    expect(result.version_id).toBe("slv_edit1");
    expect(result.version_number).toBe(3);
    expect(result.skill_id).toBe("skl_edit");
    expect(result.activated).toBe(true);
  });

  it("delegates to the same shared codepath as upload (skill.version.upload shares DB ops)", async () => {
    const input = setupHappyPath();
    await skillEditHandler(input, CTX);

    // Both handlers insert a new version row with is_latest=true
    const versionInsert = mocks.insertedValues.find(
      (v) => "isLatest" in v && (v as { isLatest: boolean }).isLatest === true,
    );
    expect(versionInsert).toBeDefined();
  });

  it("does NOT update active_version_id when activate=false", async () => {
    const input = setupHappyPath({ activate: false });
    const result = await skillEditHandler(input, CTX);

    expect(result.activated).toBe(false);
    // The skills activation update must not run…
    expect(mocks.skillUpdateWhere).not.toHaveBeenCalled();
    // …while the unconditional is_latest clear on skillVersions still runs.
    expect(mocks.versionUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("throws when content is not valid skill TOML", async () => {
    const input = setupHappyPath({ content: "not toml" });

    await expect(skillEditHandler(input, CTX)).rejects.toThrow(
      /invalid_artifact/i,
    );
  });

  it("throws when content fails the skill schema", async () => {
    const input = setupHappyPath({
      content: 'schema_version = 1\nkind = "skill"\nname = "ok-slug"',
    });

    await expect(skillEditHandler(input, CTX)).rejects.toThrow();
  });

  it("throws when skill not found in tenant scope", async () => {
    const input = setupHappyPath();
    mocks.selectWhere.mockResolvedValueOnce([]);

    await expect(skillEditHandler(input, CTX)).rejects.toThrow(
      /skill not found/,
    );
  });

  it("throws when no authenticated user", async () => {
    const input = setupHappyPath();
    const anonCtx = makeCTX({ userId: null });

    await expect(skillEditHandler(input, anonCtx)).rejects.toThrow(
      /authenticated user/,
    );
  });

  it("propagates DB error", async () => {
    const input = setupHappyPath();
    mocks.insertReturning.mockRejectedValueOnce(
      new Error("unique constraint violated"),
    );

    await expect(skillEditHandler(input, CTX)).rejects.toThrow(
      "unique constraint violated",
    );
  });

  it("immutability: does not attempt to modify any prior version rows (only clears is_latest)", async () => {
    const input = setupHappyPath();
    await skillEditHandler(input, CTX);

    // insert is called exactly once (new version row only)
    const versionInserts = mocks.insertedValues.filter((v) => "body" in v);
    expect(versionInserts).toHaveLength(1);
  });
});
