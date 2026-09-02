// router-outcomes.test.ts
//
// Unit tests for recordRouterOutcome / readRoutingStats (tenant-scoped market
// router outcome pipe). chInsert/chSelect (the tenant seam) are mocked so no live
// ClickHouse is needed; we assert the insert row shape, the tenant-filtered read
// query (org_id + workspace_id + window + optional task class + minSamples
// HAVING), the params, and the snake→camel row mapping. NOTE: a mocked CH cannot
// validate the SQL itself — the query is kept aligned with the house template in
// usage-analytics.ts and against the router_outcomes DDL columns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(
  async (_table: string, _rows: readonly Record<string, unknown>[]) => {},
);
const chSelect = vi.fn(
  async <T>(_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as T[],
  }),
);

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) =>
    chInsert(table, rows),
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import { recordRouterOutcome, readRoutingStats } from "./router-outcomes";
import type { RouterOutcomeRow } from "./router-outcomes";

const outcome: RouterOutcomeRow = {
  execution_id: "exec-1",
  task_class: "auth/single",
  signature_hash: "abc123",
  model: "anthropic/claude-sonnet-5",
  tier: "balanced",
  verified: 1,
  verification_source: "tests",
  score: 0.98,
  cost_usd_micros: 4200,
  latency_ms: 3100,
  surface: "app",
  routing_mode: "enforce",
};

beforeEach(() => {
  chInsert.mockClear();
  chSelect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordRouterOutcome", () => {
  it("inserts one row into router_outcomes verbatim (scope stamped by chInsert)", async () => {
    await recordRouterOutcome(outcome);
    expect(chInsert).toHaveBeenCalledTimes(1);
    expect(chInsert).toHaveBeenCalledWith("router_outcomes", [outcome]);
    // The caller never supplies org_id/workspace_id — the tenant seam stamps them.
    const [, rows] = chInsert.mock.calls[0]!;
    expect(rows[0]).not.toHaveProperty("org_id");
    expect(rows[0]).not.toHaveProperty("workspace_id");
  });
});

describe("readRoutingStats", () => {
  it("filters by org_id + workspace_id + window and groups by (task_class, model)", async () => {
    chSelect.mockResolvedValueOnce({ data: [] });
    await readRoutingStats({ windowDays: 30, minSamples: 20 });
    expect(chSelect).toHaveBeenCalledTimes(1);
    const call = chSelect.mock.calls[0]![0] as {
      query: string;
      params?: Record<string, unknown>;
    };
    expect(call.query).toContain("FROM router_outcomes");
    expect(call.query).toContain("org_id = {orgId:UUID}");
    expect(call.query).toContain("workspace_id = {workspaceId:UUID}");
    expect(call.query).toContain("GROUP BY task_class, model");
    expect(call.query).toContain("HAVING samples >= {minSamples:UInt32}");
    expect(call.query).toContain("toIntervalDay({windowDays:UInt32})");
    // No task-class filter when omitted.
    expect(call.query).not.toContain("task_class = {taskClass:String}");
    expect(call.params).toEqual({ windowDays: 30, minSamples: 20 });
  });

  it("adds the task-class filter and param when a task class is supplied", async () => {
    chSelect.mockResolvedValueOnce({ data: [] });
    await readRoutingStats({
      taskClass: "auth/single",
      windowDays: 7,
      minSamples: 5,
    });
    const call = chSelect.mock.calls[0]![0] as {
      query: string;
      params?: Record<string, unknown>;
    };
    expect(call.query).toContain("AND task_class = {taskClass:String}");
    expect(call.params).toEqual({
      windowDays: 7,
      minSamples: 5,
      taskClass: "auth/single",
    });
  });

  it("floors and clamps window/minSamples params to safe non-negative integers", async () => {
    chSelect.mockResolvedValueOnce({ data: [] });
    await readRoutingStats({ windowDays: 30.9, minSamples: -3 });
    const call = chSelect.mock.calls[0]![0] as {
      params?: Record<string, unknown>;
    };
    expect(call.params).toEqual({ windowDays: 30, minSamples: 0 });
  });

  it("maps the raw snake_case aggregate rows to camelCase with numeric coercion", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        {
          task_class: "auth/single",
          model: "anthropic/claude-sonnet-5",
          tier: "balanced",
          // UInt64 aggregates arrive as decimal strings on the JSON wire.
          samples: "42",
          verified_count: "40",
          verified_rate: 0.952,
          avg_cost_usd_micros: 4200.5,
          avg_latency_ms: 3100.2,
          last_seen: "2026-07-10 12:00:00.000",
        },
      ],
    });
    const rows = await readRoutingStats({ windowDays: 30, minSamples: 20 });
    expect(rows).toEqual([
      {
        taskClass: "auth/single",
        model: "anthropic/claude-sonnet-5",
        tier: "balanced",
        samples: 42,
        verifiedCount: 40,
        verifiedRate: 0.952,
        avgCostUsdMicros: 4200.5,
        avgLatencyMs: 3100.2,
        lastSeen: "2026-07-10 12:00:00.000",
      },
    ]);
  });

  it("returns an empty array when there are no outcomes", async () => {
    chSelect.mockResolvedValueOnce({ data: [] });
    const rows = await readRoutingStats({ windowDays: 30, minSamples: 20 });
    expect(rows).toEqual([]);
  });
});
