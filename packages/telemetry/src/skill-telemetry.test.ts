// skill-telemetry.test.ts
//
// Unit tests for recordSkillLoad + readSkillMetrics. The ClickHouse
// client is mocked so no live server is needed; we assert the insert row shape,
// the query SQL/params (including the optional skillId filter branch), and the
// aggregation/reduction of raw rows into the metrics shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface InsertCall {
  table: string;
  values: SkillLoadRow[];
  format: string;
}
interface QueryCall {
  query: string;
  query_params: Record<string, unknown>;
}

const insertMock = vi.fn(async (_args: InsertCall): Promise<void> => {});
const queryMock =
  vi.fn<(args: QueryCall) => Promise<{ json: () => Promise<unknown[]> }>>();

vi.mock("./clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse")>();
  return {
    ...actual,
    clickhouse: () => ({ insert: insertMock, query: queryMock }),
  };
});

import {
  readSkillMetrics,
  readSkillTokenCosts,
  recordSkillLoad,
} from "./skill-telemetry";
import type { SkillLoadRow } from "./skill-telemetry";
import { NIL_UUID } from "./clickhouse";

beforeEach(() => {
  insertMock.mockClear();
  queryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseRow: SkillLoadRow = {
  org_id: "org-1",
  workspace_id: "ws-1",
  skill_id: "skill-1",
  skill_slug: "code-audit",
  skill_version: 3,
  execution_step_id: "step-9",
  surface: "app",
  load_latency_ms: 42,
  created_at: "2026-06-18T12:00:00.000Z",
};

describe("recordSkillLoad", () => {
  it("inserts one row into skill_loads as JSONEachRow", async () => {
    await recordSkillLoad(baseRow);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const call = insertMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("insert not called");
    expect(call.table).toBe("skill_loads");
    expect(call.format).toBe("JSONEachRow");
    expect(call.values).toHaveLength(1);
    expect(call.values[0]).toEqual(baseRow);
    expect(call.values).toEqual([baseRow]);
  });

  it("passes through NULL nullable columns explicitly", async () => {
    const row: SkillLoadRow = {
      ...baseRow,
      execution_step_id: null,
      load_latency_ms: null,
      surface: "",
    };
    await recordSkillLoad(row);
    const call = insertMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("insert not called");
    const inserted = call.values[0];
    expect(inserted).toBeDefined();
    expect(inserted?.execution_step_id).toBeNull();
    expect(inserted?.load_latency_ms).toBeNull();
  });
});

describe("readSkillMetrics", () => {
  function mockQueries(
    bySkill: Array<Record<string, unknown>>,
    byVersion: Array<Record<string, unknown>>,
  ): void {
    queryMock
      .mockResolvedValueOnce({ json: async () => bySkill })
      .mockResolvedValueOnce({ json: async () => byVersion });
  }

  it("aggregates bySkill, byVersion, totalLoads and lastUsed", async () => {
    mockQueries(
      [
        {
          skill_id: "a",
          skill_slug: "alpha",
          loads: "5",
          last_used: "2026-06-18T10:00:00.000Z",
        },
        {
          skill_id: "b",
          skill_slug: "beta",
          loads: "2",
          last_used: "2026-06-18T12:00:00.000Z",
        },
      ],
      [
        {
          skill_id: "a",
          skill_version: "2",
          loads: "3",
          last_used: "2026-06-18T10:00:00.000Z",
        },
        {
          skill_id: "a",
          skill_version: "1",
          loads: "2",
          last_used: "2026-06-17T10:00:00.000Z",
        },
        {
          skill_id: "b",
          skill_version: "1",
          loads: "2",
          last_used: "2026-06-18T12:00:00.000Z",
        },
      ],
    );

    const result = await readSkillMetrics({
      orgId: "org-1",
      workspaceId: "ws-1",
    });

    expect(result.bySkill).toEqual([
      {
        skill_id: "a",
        skill_slug: "alpha",
        loads: 5,
        last_used: "2026-06-18T10:00:00.000Z",
      },
      {
        skill_id: "b",
        skill_slug: "beta",
        loads: 2,
        last_used: "2026-06-18T12:00:00.000Z",
      },
    ]);
    expect(result.byVersion).toEqual([
      {
        skill_id: "a",
        skill_version: 2,
        loads: 3,
        last_used: "2026-06-18T10:00:00.000Z",
      },
      {
        skill_id: "a",
        skill_version: 1,
        loads: 2,
        last_used: "2026-06-17T10:00:00.000Z",
      },
      {
        skill_id: "b",
        skill_version: 1,
        loads: 2,
        last_used: "2026-06-18T12:00:00.000Z",
      },
    ]);
    expect(result.totalLoads).toBe(7);
    // lastUsed is the max across skills.
    expect(result.lastUsed).toBe("2026-06-18T12:00:00.000Z");
  });

  it("returns zeros / null for an empty scope", async () => {
    mockQueries([], []);
    const result = await readSkillMetrics({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(result.bySkill).toEqual([]);
    expect(result.byVersion).toEqual([]);
    expect(result.totalLoads).toBe(0);
    expect(result.lastUsed).toBeNull();
  });

  it("does not bind skillId param and omits the filter when skillId is absent", async () => {
    mockQueries([], []);
    await readSkillMetrics({ orgId: "org-1", workspaceId: "ws-1" });
    for (const call of queryMock.mock.calls) {
      const arg = call[0];
      expect(arg.query_params).not.toHaveProperty("skillId");
      expect(arg.query).not.toContain("skill_id = {skillId:String}");
      expect(arg.query).toContain("org_id = {orgId:String}");
      expect(arg.query).toContain("workspace_id = {workspaceId:String}");
    }
  });

  it("binds skillId and applies the filter when skillId is supplied", async () => {
    mockQueries(
      [
        {
          skill_id: "x",
          skill_slug: "xray",
          loads: "4",
          last_used: "2026-06-18T09:00:00.000Z",
        },
      ],
      [
        {
          skill_id: "x",
          skill_version: "1",
          loads: "4",
          last_used: "2026-06-18T09:00:00.000Z",
        },
      ],
    );
    const result = await readSkillMetrics({
      orgId: "org-1",
      workspaceId: "ws-1",
      skillId: "x",
    });
    for (const call of queryMock.mock.calls) {
      const arg = call[0];
      expect(arg.query_params.skillId).toBe("x");
      expect(arg.query).toContain("skill_id = {skillId:String}");
    }
    expect(result.totalLoads).toBe(4);
    expect(result.lastUsed).toBe("2026-06-18T09:00:00.000Z");
  });

  it("ignores null last_used values when computing lastUsed", async () => {
    mockQueries(
      [
        { skill_id: "a", skill_slug: "alpha", loads: "1", last_used: null },
        {
          skill_id: "b",
          skill_slug: "beta",
          loads: "1",
          last_used: "2026-06-18T08:00:00.000Z",
        },
      ],
      [],
    );
    const result = await readSkillMetrics({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(result.lastUsed).toBe("2026-06-18T08:00:00.000Z");
  });

  it("keeps the already-newer lastUsed when a subsequent skill has an older timestamp", async () => {
    // Covers the `return latest` branch inside the lastUsed reduce (line 164):
    // hit when a skill's last_used is non-null but OLDER than the current max.
    mockQueries(
      [
        // skill_a has the NEWER time (loaded more, appears first by DESC loads)
        {
          skill_id: "a",
          skill_slug: "alpha",
          loads: "10",
          last_used: "2026-06-18T15:00:00.000Z",
        },
        // skill_b has an OLDER time → the reduce's `return latest` arm fires here
        {
          skill_id: "b",
          skill_slug: "beta",
          loads: "2",
          last_used: "2026-06-18T08:00:00.000Z",
        },
      ],
      [],
    );
    const result = await readSkillMetrics({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    // latest is correctly the newer of the two
    expect(result.lastUsed).toBe("2026-06-18T15:00:00.000Z");
    expect(result.totalLoads).toBe(12);
  });
});

describe("readSkillTokenCosts", () => {
  it("aggregates cost_usd_micros per skill from the join result", async () => {
    queryMock.mockResolvedValueOnce({
      json: async () => [
        { skill_id: "a", cost_usd_micros: "1250000" },
        { skill_id: "b", cost_usd_micros: "30000" },
      ],
    });

    const result = await readSkillTokenCosts({
      orgId: "org-1",
      workspaceId: "ws-1",
    });

    expect(result).toEqual([
      { skill_id: "a", cost_usd_micros: 1_250_000 },
      { skill_id: "b", cost_usd_micros: 30_000 },
    ]);
  });

  it("returns an empty array when no steps have attributable cost", async () => {
    queryMock.mockResolvedValueOnce({ json: async () => [] });
    const result = await readSkillTokenCosts({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(result).toEqual([]);
  });

  it("joins skill_loads to token_usage on execution_step_id and excludes NIL/empty steps", async () => {
    queryMock.mockResolvedValueOnce({ json: async () => [] });
    await readSkillTokenCosts({ orgId: "org-1", workspaceId: "ws-1" });

    const arg = queryMock.mock.calls[0]?.[0];
    if (!arg) throw new Error("query not called");
    // Join key + both tables present.
    expect(arg.query).toContain("FROM skill_loads");
    expect(arg.query).toContain("FROM token_usage");
    expect(arg.query).toContain("tu.step_id = sl.execution_step_id");
    // NIL/empty/null steps excluded on both sides.
    expect(arg.query).toContain("execution_step_id IS NOT NULL");
    expect(arg.query).toContain("execution_step_id != ''");
    expect(arg.query).toContain("execution_step_id != {nilUuid:String}");
    expect(arg.query).toContain(
      "execution_step_id != toUUID({nilUuid:String})",
    );
    // Org/workspace filtered with the correct per-table types.
    expect(arg.query).toContain("org_id = {orgId:String}");
    expect(arg.query).toContain("org_id = {orgId:UUID}");
    expect(arg.query).toContain("workspace_id = {workspaceId:UUID}");
    expect(arg.query_params.nilUuid).toBe(NIL_UUID);
    // No skill filter bound when skillId is absent.
    expect(arg.query_params).not.toHaveProperty("skillId");
    expect(arg.query).not.toContain("skill_id = {skillId:String}");
  });

  it("binds skillId and applies the filter when a single skill is requested", async () => {
    queryMock.mockResolvedValueOnce({
      json: async () => [{ skill_id: "x", cost_usd_micros: "500000" }],
    });
    const result = await readSkillTokenCosts({
      orgId: "org-1",
      workspaceId: "ws-1",
      skillId: "x",
    });

    const arg = queryMock.mock.calls[0]?.[0];
    if (!arg) throw new Error("query not called");
    expect(arg.query_params.skillId).toBe("x");
    expect(arg.query).toContain("skill_id = {skillId:String}");
    expect(result).toEqual([{ skill_id: "x", cost_usd_micros: 500_000 }]);
  });
});
