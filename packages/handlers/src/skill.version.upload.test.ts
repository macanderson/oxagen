import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// createNewSkillVersion runs a single withTenantDb transaction issuing, in order:
//   1. skill lookup        → select(...).from(skills).where(...)              (no .limit)
//   2. max version lookup  → select(...).from(skillVersions).where(...)       (no .limit)
//   3. prior-latest lookup → select(...).from(skillVersions).where(...).limit(1)
//   4. clear is_latest     → update(skillVersions).set(...).where(...)        (only when a prior latest exists)
//   5. insert version      → insert(skillVersions).values(...).returning(...)
//   6. activate skill      → update(skills).set(...).where(...)               (ONLY if activate)
// The two updates target different tables; we route them to separate spies by
// comparing the table identity against the real schema so the "skips skills
// update" assertion checks the correct (skills) update, not the is_latest
// clear on skillVersions.
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
name = "my-skill"
description = "A test skill"
instructions = "This skill helps you do things."
references = ["refs/example.md"]
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
              if (selectCallCount === 1) {
                // 1st: skill lookup (awaited directly, no .limit)
                return mocks.selectWhere();
              }
              if (selectCallCount === 2) {
                // 2nd: max version lookup (awaited directly, no .limit)
                return mocks.selectMaxWhere();
              }
              // 3rd: prior-latest lookup — chains .limit(1)
              return { limit: (_n: number) => mocks.selectPriorLatestWhere() };
            },
          }),
        }),
        insert: (_table: unknown) => ({
          values: (vals: unknown) => {
            mocks.insertedValues.push(vals as Record<string, unknown>);
            return {
              returning: mocks.insertReturning,
            };
          },
        }),
        update: (table: unknown) => ({
          set: (_vals: unknown) => ({
            // Route by table identity: the skills-table update is the activation
            // step (only when activate=true); the skillVersions update clears is_latest.
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

import { skillVersionUploadHandler } from "./skill.version.upload";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  skill_id: "skl_abc",
  content: VALID_CONTENT,
  change_summary: undefined as string | undefined,
  activate: true,
  workspace_id: undefined as string | undefined,
};

const SKILL_ROW = { id: "skill-uuid-1", publicId: "skl_abc" };
const VERSION_ROW = { id: "ver-uuid-1", publicId: "slv_xyz", versionNumber: 2 };
const MAX_ROW = [{ maxVersion: 1 }];
const PRIOR_LATEST_ROW = {
  id: "ver-uuid-0",
  referencesPayload: [{ path: "refs/example.md", body: "ref body" }],
};

function setupHappyPath(overrides: Partial<typeof BASE_INPUT> = {}) {
  mocks.selectWhere.mockReset();
  mocks.selectMaxWhere.mockReset();
  mocks.selectPriorLatestWhere.mockReset();
  mocks.insertReturning.mockReset();
  mocks.versionUpdateWhere.mockReset();
  mocks.skillUpdateWhere.mockReset();
  mocks.insertedValues.length = 0;

  mocks.selectWhere.mockResolvedValue([SKILL_ROW]);
  mocks.selectMaxWhere.mockResolvedValue(MAX_ROW);
  mocks.selectPriorLatestWhere.mockResolvedValue([PRIOR_LATEST_ROW]);
  mocks.insertReturning.mockResolvedValue([VERSION_ROW]);
  mocks.versionUpdateWhere.mockResolvedValue([]);
  mocks.skillUpdateWhere.mockResolvedValue([]);

  return { ...BASE_INPUT, ...overrides };
}

const CTX = makeCTX({ userId: "u_1" });

describe("skillVersionUploadHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns version_id, version_number, skill_id, activated on success", async () => {
    const input = setupHappyPath();
    const result = await skillVersionUploadHandler(input, CTX);

    expect(result.version_id).toBe("slv_xyz");
    expect(result.version_number).toBe(2);
    expect(result.skill_id).toBe("skl_abc");
    expect(result.activated).toBe(true);
  });

  it("sets activated=false when activate=false and skips skills update", async () => {
    const input = setupHappyPath({ activate: false });
    const result = await skillVersionUploadHandler(input, CTX);

    expect(result.activated).toBe(false);
    // The skills-table activation update must NOT run when activate=false…
    expect(mocks.skillUpdateWhere).not.toHaveBeenCalled();
    // …but clearing is_latest on skillVersions still happens unconditionally.
    expect(mocks.versionUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("increments version_number beyond existing max", async () => {
    const input = setupHappyPath();
    mocks.selectMaxWhere.mockResolvedValueOnce([{ maxVersion: 5 }]);
    mocks.insertReturning.mockResolvedValueOnce([
      { id: "ver-uuid-6", publicId: "slv_v6", versionNumber: 6 },
    ]);

    const result = await skillVersionUploadHandler(input, CTX);
    expect(result.version_number).toBe(6);
  });

  it("starts at version 1 when no prior versions exist (maxVersion=null)", async () => {
    const input = setupHappyPath();
    mocks.selectMaxWhere.mockResolvedValueOnce([{ maxVersion: null }]);
    mocks.insertReturning.mockResolvedValueOnce([
      { id: "ver-uuid-1a", publicId: "slv_v1", versionNumber: 1 },
    ]);

    const result = await skillVersionUploadHandler(input, CTX);
    expect(result.version_number).toBe(1);
  });

  it("inserts a version row with is_latest=true", async () => {
    const input = setupHappyPath();
    await skillVersionUploadHandler(input, CTX);

    const inserted = mocks.insertedValues.find(
      (v) => "isLatest" in v && (v as { isLatest: boolean }).isLatest === true,
    );
    expect(inserted).toBeDefined();
    expect((inserted as { isLatest: boolean }).isLatest).toBe(true);
  });

  it("clears is_latest on prior versions (via update before insert)", async () => {
    const input = setupHappyPath();
    await skillVersionUploadHandler(input, CTX);

    // The skillVersions is_latest clear runs once; with activate=true (default)
    // the skills activation update also runs once.
    expect(mocks.versionUpdateWhere).toHaveBeenCalledTimes(1);
    expect(mocks.skillUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("stamps checksum, lineage, and artifact reference projections on the new row", async () => {
    const input = setupHappyPath({ change_summary: "tighten wording" });
    await skillVersionUploadHandler(input, CTX);

    const inserted = mocks.insertedValues[0] as {
      checksum: string;
      parentVersionId: string | null;
      referencesPayload: unknown;
      changeSummary: string | null;
    };
    expect(inserted.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.parentVersionId).toBe("ver-uuid-0");
    expect(inserted.referencesPayload).toEqual([
      { path: "refs/example.md", body: "" },
    ]);
    expect(inserted.changeSummary).toBe("tighten wording");
  });

  it("records null lineage and skips the is_latest clear for the first version", async () => {
    const input = setupHappyPath();
    mocks.selectMaxWhere.mockResolvedValueOnce([{ maxVersion: null }]);
    mocks.selectPriorLatestWhere.mockResolvedValueOnce([]);
    mocks.insertReturning.mockResolvedValueOnce([
      { id: "ver-uuid-1a", publicId: "slv_v1", versionNumber: 1 },
    ]);

    await skillVersionUploadHandler(input, CTX);

    const inserted = mocks.insertedValues[0] as {
      parentVersionId: string | null;
      referencesPayload: unknown;
      changeSummary: string | null;
    };
    expect(inserted.parentVersionId).toBeNull();
    expect(inserted.referencesPayload).toEqual([
      { path: "refs/example.md", body: "" },
    ]);
    expect(inserted.changeSummary).toBeNull();
    expect(mocks.versionUpdateWhere).not.toHaveBeenCalled();
  });

  it("throws when skill not found", async () => {
    const input = setupHappyPath();
    mocks.selectWhere.mockResolvedValueOnce([]);

    await expect(skillVersionUploadHandler(input, CTX)).rejects.toThrow(
      /skill not found/,
    );
  });

  it("throws when content is not valid skill TOML", async () => {
    const input = setupHappyPath({ content: "not toml" });

    await expect(skillVersionUploadHandler(input, CTX)).rejects.toThrow(
      /invalid_artifact/i,
    );
  });

  it("throws when no authenticated user", async () => {
    const input = setupHappyPath();
    const anonCtx = makeCTX({ userId: null });

    await expect(skillVersionUploadHandler(input, anonCtx)).rejects.toThrow(
      /authenticated user/,
    );
  });

  it("propagates DB error from insert", async () => {
    const input = setupHappyPath();
    mocks.insertReturning.mockRejectedValueOnce(new Error("DB write failed"));

    await expect(skillVersionUploadHandler(input, CTX)).rejects.toThrow(
      "DB write failed",
    );
  });

  it("propagates DB error from skill lookup", async () => {
    const input = setupHappyPath();
    mocks.selectWhere.mockRejectedValueOnce(new Error("connection lost"));

    await expect(skillVersionUploadHandler(input, CTX)).rejects.toThrow(
      "connection lost",
    );
  });
});
