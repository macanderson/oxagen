/**
 * skill.metrics.read handler tests
 *
 * Strategy:
 *   - Stub @oxagen/database (withTenantDb) and @oxagen/telemetry (readSkillMetrics)
 *     so no live ClickHouse or Postgres is required.
 *   - Cover: workspace-wide aggregation, single-skill filter, ClickHouse fallback on
 *     telemetry error, nullable fields, empty workspace.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  /**
   * The first call to withTenantDb returns skills rows; the second (version
   * resolution) returns version rows. We expose a single array of return-value
   * overrides consumed in FIFO order.
   */
  withTenantDbCallResults: [] as unknown[][],
  readSkillMetrics: vi.fn(),
  readSkillTokenCosts: vi.fn(),
}));

// Stub @oxagen/database so no real Postgres connection is opened.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const rows = mocks.withTenantDbCallResults.shift() ?? [];
      // Build a minimal chainable query-builder stub.
      const tx = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(rows),
          }),
        }),
      };
      return fn(tx);
    },
  };
});

// Stub @oxagen/telemetry so no real ClickHouse connection is opened.
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    readSkillMetrics: mocks.readSkillMetrics,
    readSkillTokenCosts: mocks.readSkillTokenCosts,
  };
});

// ── import under test (after mocks) ──────────────────────────────────────────

import { skillMetricsReadHandler } from "./skill.metrics.read";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

const makeSkillRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "skl_abc",
  slug: "code-audit",
  usageCount: 10,
  lastUsedAt: new Date("2026-06-18T12:00:00.000Z"),
  activeVersionId: "vid_1",
  ...overrides,
});

const makeVersionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "vid_1",
  versionNumber: 3,
  ...overrides,
});

const makeChMetrics = (
  overrides: Partial<ReturnType<typeof defaultChMetrics>> = {},
) => ({
  ...defaultChMetrics(),
  ...overrides,
});

function defaultChMetrics() {
  return {
    bySkill: [
      {
        skill_id: "skl_abc",
        skill_slug: "code-audit",
        loads: 10,
        last_used: "2026-06-18T12:00:00.000Z",
      },
    ],
    byVersion: [
      {
        skill_id: "skl_abc",
        skill_version: 3,
        loads: 8,
        last_used: "2026-06-18T12:00:00.000Z",
      },
      {
        skill_id: "skl_abc",
        skill_version: 2,
        loads: 2,
        last_used: "2026-06-10T08:00:00.000Z",
      },
    ],
    totalLoads: 10,
    lastUsed: "2026-06-18T12:00:00.000Z",
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("skillMetricsReadHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTenantDbCallResults.length = 0;
    mocks.readSkillMetrics.mockResolvedValue(makeChMetrics());
    // Default: no attributable token cost (empty join result). Individual tests
    // override with rows or a rejection to exercise cost wiring.
    mocks.readSkillTokenCosts.mockResolvedValue([]);
  });

  // ── empty workspace ────────────────────────────────────────────────────────

  it("returns empty skills array when no skills exist in workspace", async () => {
    mocks.withTenantDbCallResults.push([]); // skills rows
    // No version resolution call when there are no active version IDs.
    const result = await skillMetricsReadHandler({}, CTX);
    expect(result).toEqual({ skills: [] });
  });

  // ── workspace-wide aggregation ────────────────────────────────────────────

  it("returns one skill with correct shape for workspace-wide query", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]); // skills query
    mocks.withTenantDbCallResults.push([makeVersionRow()]); // version resolution
    mocks.readSkillMetrics.mockResolvedValue(makeChMetrics());

    const result = await skillMetricsReadHandler({}, CTX);

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.skillId).toBe("skl_abc");
    expect(skill.slug).toBe("code-audit");
    expect(skill.activeVersion).toBe(3);
    expect(skill.usageCount).toBe(10);
    expect(skill.lastUsedAt).toBe("2026-06-18T12:00:00.000Z");
    // approxTokenCost is null when the token-cost join returns no rows for it
    expect(skill.approxTokenCost).toBeNull();
    // perVersionLoads derived from ClickHouse
    expect(skill.perVersionLoads).toHaveLength(2);
    expect(skill.perVersionLoads[0]).toEqual({
      version: 3,
      loads: 8,
      lastUsed: "2026-06-18T12:00:00.000Z",
    });
    expect(skill.perVersionLoads[1]).toEqual({
      version: 2,
      loads: 2,
      lastUsed: "2026-06-10T08:00:00.000Z",
    });
  });

  // ── single-skill filter ────────────────────────────────────────────────────

  it("narrows to the specified skillId when provided", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    mocks.readSkillMetrics.mockResolvedValue(makeChMetrics());

    const result = await skillMetricsReadHandler({ skillId: "skl_abc" }, CTX);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.skillId).toBe("skl_abc");
    // readSkillMetrics was called with the skillId
    expect(mocks.readSkillMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skl_abc" }),
    );
  });

  // ── nullable fields ────────────────────────────────────────────────────────

  it("returns null activeVersion when activeVersionId is null", async () => {
    mocks.withTenantDbCallResults.push([
      makeSkillRow({ activeVersionId: null }),
    ]);
    // No second query since there are no activeVersionIds to resolve.
    mocks.readSkillMetrics.mockResolvedValue(
      makeChMetrics({ byVersion: [], bySkill: [] }),
    );

    const result = await skillMetricsReadHandler({}, CTX);
    expect(result.skills[0]!.activeVersion).toBeNull();
  });

  it("returns null lastUsedAt when DB column is null", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow({ lastUsedAt: null })]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    mocks.readSkillMetrics.mockResolvedValue(makeChMetrics());

    const result = await skillMetricsReadHandler({}, CTX);
    expect(result.skills[0]!.lastUsedAt).toBeNull();
  });

  it("returns empty perVersionLoads when ClickHouse has no entries for a skill", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    // ClickHouse returns data for a DIFFERENT skill only
    mocks.readSkillMetrics.mockResolvedValue(
      makeChMetrics({
        byVersion: [
          {
            skill_id: "skl_other",
            skill_version: 1,
            loads: 5,
            last_used: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const result = await skillMetricsReadHandler({}, CTX);
    expect(result.skills[0]!.perVersionLoads).toHaveLength(0);
  });

  // ── ClickHouse degradation ─────────────────────────────────────────────────

  it("returns empty perVersionLoads and does not throw when ClickHouse is unavailable", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    mocks.readSkillMetrics.mockRejectedValue(
      new Error("ClickHouse connection refused"),
    );

    const result = await skillMetricsReadHandler({}, CTX);

    expect(result.skills).toHaveLength(1);
    // Per-version loads from ClickHouse are empty on fallback
    expect(result.skills[0]!.perVersionLoads).toHaveLength(0);
    // Postgres-sourced fields are still present
    expect(result.skills[0]!.usageCount).toBe(10);
    expect(result.skills[0]!.lastUsedAt).toBe("2026-06-18T12:00:00.000Z");
  });

  // ── multi-skill workspace ─────────────────────────────────────────────────

  it("handles multiple skills in workspace and maps each independently", async () => {
    mocks.withTenantDbCallResults.push([
      makeSkillRow({
        publicId: "skl_1",
        slug: "audit",
        activeVersionId: "vid_1",
      }),
      makeSkillRow({
        publicId: "skl_2",
        slug: "summarize",
        activeVersionId: "vid_2",
        usageCount: 5,
      }),
    ]);
    mocks.withTenantDbCallResults.push([
      makeVersionRow({ id: "vid_1", versionNumber: 2 }),
      makeVersionRow({ id: "vid_2", versionNumber: 1 }),
    ]);
    mocks.readSkillMetrics.mockResolvedValue({
      bySkill: [],
      byVersion: [
        {
          skill_id: "skl_1",
          skill_version: 2,
          loads: 10,
          last_used: "2026-06-18T12:00:00.000Z",
        },
        {
          skill_id: "skl_2",
          skill_version: 1,
          loads: 5,
          last_used: "2026-06-15T00:00:00.000Z",
        },
      ],
      totalLoads: 15,
      lastUsed: "2026-06-18T12:00:00.000Z",
    });

    const result = await skillMetricsReadHandler({}, CTX);

    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]!.skillId).toBe("skl_1");
    expect(result.skills[0]!.activeVersion).toBe(2);
    expect(result.skills[0]!.perVersionLoads).toHaveLength(1);

    expect(result.skills[1]!.skillId).toBe("skl_2");
    expect(result.skills[1]!.activeVersion).toBe(1);
    expect(result.skills[1]!.usageCount).toBe(5);
    expect(result.skills[1]!.perVersionLoads).toHaveLength(1);
  });

  // ── usageCount edge case ───────────────────────────────────────────────────

  it("returns usageCount=0 for a skill with no recorded invocations", async () => {
    mocks.withTenantDbCallResults.push([
      makeSkillRow({ usageCount: 0, lastUsedAt: null, activeVersionId: null }),
    ]);
    mocks.readSkillMetrics.mockResolvedValue({
      bySkill: [],
      byVersion: [],
      totalLoads: 0,
      lastUsed: null,
    });

    const result = await skillMetricsReadHandler({}, CTX);
    expect(result.skills[0]!.usageCount).toBe(0);
    expect(result.skills[0]!.lastUsedAt).toBeNull();
    expect(result.skills[0]!.perVersionLoads).toHaveLength(0);
  });

  // ── approxTokenCost (token_usage join) ──────────────────────────────────────

  it("reports approxTokenCost in USD cents when token rows exist for the skill", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    // 1_250_000 micros = $1.25 = 125 cents.
    mocks.readSkillTokenCosts.mockResolvedValue([
      { skill_id: "skl_abc", cost_usd_micros: 1_250_000 },
    ]);

    const result = await skillMetricsReadHandler({}, CTX);

    expect(result.skills[0]!.approxTokenCost).toBe(125);
    expect(mocks.readSkillTokenCosts).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
      }),
    );
  });

  it("returns null approxTokenCost when the skill has no token rows (but others do)", async () => {
    mocks.withTenantDbCallResults.push([
      makeSkillRow({ publicId: "skl_1", activeVersionId: "vid_1" }),
      makeSkillRow({ publicId: "skl_2", activeVersionId: "vid_2" }),
    ]);
    mocks.withTenantDbCallResults.push([
      makeVersionRow({ id: "vid_1", versionNumber: 1 }),
      makeVersionRow({ id: "vid_2", versionNumber: 1 }),
    ]);
    // Only skl_1 has attributable cost; skl_2 is absent from the join result.
    mocks.readSkillTokenCosts.mockResolvedValue([
      { skill_id: "skl_1", cost_usd_micros: 500_000 },
    ]);

    const result = await skillMetricsReadHandler({}, CTX);

    expect(result.skills[0]!.approxTokenCost).toBe(50); // $0.50 → 50 cents
    expect(result.skills[1]!.approxTokenCost).toBeNull();
  });

  it("returns null approxTokenCost (not zero) and does not throw when the cost query fails", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    mocks.readSkillTokenCosts.mockRejectedValue(
      new Error("ClickHouse join failed"),
    );

    const result = await skillMetricsReadHandler({}, CTX);

    // Cost-query failure degrades ONLY approxTokenCost — load metrics survive.
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.approxTokenCost).toBeNull();
    expect(result.skills[0]!.perVersionLoads).toHaveLength(2);
    expect(result.skills[0]!.usageCount).toBe(10);
  });

  it("forwards skillId to readSkillTokenCosts when filtering to one skill", async () => {
    mocks.withTenantDbCallResults.push([makeSkillRow()]);
    mocks.withTenantDbCallResults.push([makeVersionRow()]);
    mocks.readSkillTokenCosts.mockResolvedValue([
      { skill_id: "skl_abc", cost_usd_micros: 30_000 },
    ]);

    const result = await skillMetricsReadHandler({ skillId: "skl_abc" }, CTX);

    expect(result.skills[0]!.approxTokenCost).toBe(3); // $0.03 → 3 cents
    expect(mocks.readSkillTokenCosts).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skl_abc" }),
    );
  });
});
