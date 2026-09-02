import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // Each mock.select call returns a builder:
  //   .from() -> .where() -> .limit() -> resolves to rows[]
  skillRows: vi.fn<() => unknown[]>(),
  versionRows: vi.fn<() => unknown[]>(),
  updateWhere: vi.fn<() => void>(),
}));

// Call sequence tracking so we can differentiate the two selects.
let selectCallCount = 0;

const makeTx = () => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          selectCallCount += 1;
          if (selectCallCount === 1) return mocks.skillRows();
          return mocks.versionRows();
        },
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: mocks.updateWhere,
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

import { skillVersionActivateHandler } from "./skill.version.activate";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

const SKILL_ROW = {
  id: "uuid-skill-1",
  publicId: "skl_abc",
  workspaceId: CTX.workspaceId,
  orgId: CTX.orgId,
};

const VERSION_ROW = {
  id: "uuid-ver-3",
  versionNumber: 3,
  orgId: CTX.orgId,
  workspaceId: CTX.workspaceId,
};

const OLDER_VERSION_ROW = {
  id: "uuid-ver-1",
  versionNumber: 1,
  orgId: CTX.orgId,
  workspaceId: CTX.workspaceId,
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("skillVersionActivateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
    mocks.skillRows.mockResolvedValue([SKILL_ROW]);
    mocks.versionRows.mockResolvedValue([VERSION_ROW]);
    mocks.updateWhere.mockResolvedValue(undefined);
  });

  it("returns skillId, activeVersionNumber, and activatedAt on success", async () => {
    const result = await skillVersionActivateHandler(
      { skillId: "skl_abc", versionNumber: 3 },
      CTX,
    );

    expect(result.skillId).toBe("skl_abc");
    expect(result.activeVersionNumber).toBe(3);
    expect(typeof result.activatedAt).toBe("string");
    // activatedAt must be a valid ISO 8601 date
    expect(new Date(result.activatedAt).getTime()).not.toBeNaN();
  });

  it("calls update exactly once to re-point active_version_id", async () => {
    await skillVersionActivateHandler(
      { skillId: "skl_abc", versionNumber: 3 },
      CTX,
    );
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
  });

  it("can re-activate an older version (versionNumber < latest)", async () => {
    mocks.versionRows.mockResolvedValueOnce([OLDER_VERSION_ROW]);

    const result = await skillVersionActivateHandler(
      { skillId: "skl_abc", versionNumber: 1 },
      CTX,
    );
    expect(result.activeVersionNumber).toBe(1);
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
  });

  it("throws when skill not found in tenant workspace (tenant isolation)", async () => {
    mocks.skillRows.mockResolvedValueOnce([]);

    await expect(
      skillVersionActivateHandler(
        { skillId: "skl_unknown", versionNumber: 1 },
        CTX,
      ),
    ).rejects.toThrow("skill not found");
  });

  it("throws when version not found for the skill", async () => {
    mocks.versionRows.mockResolvedValueOnce([]);

    await expect(
      skillVersionActivateHandler(
        { skillId: "skl_abc", versionNumber: 99 },
        CTX,
      ),
    ).rejects.toThrow("version 99 not found");
  });

  it("propagates DB error from skill lookup", async () => {
    mocks.skillRows.mockRejectedValueOnce(new Error("DB connection failed"));

    await expect(
      skillVersionActivateHandler(
        { skillId: "skl_abc", versionNumber: 1 },
        CTX,
      ),
    ).rejects.toThrow("DB connection failed");
  });

  it("propagates DB error from update", async () => {
    mocks.updateWhere.mockRejectedValueOnce(new Error("update failed"));

    await expect(
      skillVersionActivateHandler(
        { skillId: "skl_abc", versionNumber: 3 },
        CTX,
      ),
    ).rejects.toThrow("update failed");
  });

  it("cannot activate a skill from a different workspace (another workspace's skill returns not-found)", async () => {
    // Simulate another workspace's skill not being found because the query
    // is scoped by workspaceId + orgId in the WHERE clause.
    mocks.skillRows.mockResolvedValueOnce([]);

    const alienCtx: CapabilityContext = makeCTX({
      workspaceId: "ws_other",
      orgId: "org_other",
    });

    await expect(
      skillVersionActivateHandler(
        { skillId: "skl_abc", versionNumber: 3 },
        alienCtx,
      ),
    ).rejects.toThrow("skill not found");
  });

  it("audit columns: activatedAt is set to a recent timestamp", async () => {
    const before = Date.now();
    const result = await skillVersionActivateHandler(
      { skillId: "skl_abc", versionNumber: 3 },
      CTX,
    );
    const after = Date.now();

    const activatedTs = new Date(result.activatedAt).getTime();
    expect(activatedTs).toBeGreaterThanOrEqual(before);
    expect(activatedTs).toBeLessThanOrEqual(after);
  });
});
