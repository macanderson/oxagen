import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Module mocks -----------------------------------------------------------

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: vi.fn(),

  };
});

import { withTenantDb } from "@oxagen/database";
import { agentSubagentAggregateHandler } from "./agent.subagent.aggregate";

// ---- Test helpers -----------------------------------------------------------

import { TEST_CTX as CTX } from "../test-utils/fixtures";

type FanoutRow = {
  id: string;
  publicId: string;
  status: string;
  totalChildren: number;
  completedChildren: number;
  createdAt: Date | null;
};
type RunRow = {
  publicId: string;
  capabilityName: string;
  status: string;
  outputPayload: Record<string, unknown> | null;
  errorReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

function fanout(overrides: Partial<FanoutRow> = {}): FanoutRow {
  return {
    id: "fanuuid_1",
    publicId: "fan_1",
    status: "completed",
    totalChildren: 2,
    completedChildren: 2,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function run(id: string, output: Record<string, unknown> | null, overrides: Partial<RunRow> = {}): RunRow {
  return {
    publicId: id,
    capabilityName: "test.cap",
    status: "completed",
    outputPayload: output,
    errorReason: null,
    startedAt: new Date("2024-01-01T00:00:00Z"),
    completedAt: new Date("2024-01-01T00:01:00Z"),
    ...overrides,
  };
}

// Set up withTenantDb to return fanoutRow on the first call, runRows on the second.
function setupMocks(fanoutRow: FanoutRow | null, runs: RunRow[]) {
  vi.mocked(withTenantDb)
    .mockImplementationOnce(async (fn) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (n: number) => Promise.resolve(fanoutRow ? [fanoutRow].slice(0, n) : []),
            }),
          }),
        }),
      } as unknown as Parameters<typeof fn>[0]),
    )
    .mockImplementationOnce(async (fn) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(runs),
          }),
        }),
      } as unknown as Parameters<typeof fn>[0]),
    );
}

// ---- Tests ------------------------------------------------------------------

describe("agent.subagent.aggregate handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges non-conflicting outputs from all completed children", async () => {
    setupMocks(fanout(), [
      run("sar_1", { taskId: "t1", result: "ok" }),
      run("sar_2", { extra: 42 }),
    ]);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    expect(result.status).toBe("completed");
    expect(result.fanoutId).toBe("fan_1");
    expect(result.totalChildren).toBe(2);
    expect(result.completedChildren).toBe(2);
    expect(result.conflicts).toHaveLength(0);
    expect(result.aggregatedData).toMatchObject({ taskId: "t1", result: "ok", extra: 42 });
    expect(result.firstError).toBeNull();
    expect(result.timeline).toHaveLength(2);
  });

  it("detects conflicts when two runs produce different values for the same key", async () => {
    setupMocks(fanout(), [
      run("sar_1", { shared: "valueA" }),
      run("sar_2", { shared: "valueB" }),
    ]);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    expect(result.status).toBe("completed");
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe("shared");
    expect(conflict?.values).toContain("valueA");
    expect(conflict?.values).toContain("valueB");
    expect(result.aggregatedData).not.toHaveProperty("shared");
  });

  it("no conflict when two runs produce the same value for the same key", async () => {
    setupMocks(fanout(), [
      run("sar_1", { color: "blue" }),
      run("sar_2", { color: "blue" }),
    ]);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.aggregatedData).toMatchObject({ color: "blue" });
  });

  it("reports 'partial' (not 'failed') with merged data + firstError when some succeed and some fail", async () => {
    setupMocks(fanout({ status: "partial" }), [
      run("sar_1", { result: "ok" }),
      run("sar_2", null, { status: "failed", errorReason: "OOM error", outputPayload: null }),
    ]);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    // Distinct from "failed": a mixed outcome surfaces the successful subset.
    expect(result.status).toBe("partial");
    expect(result.firstError).toBe("OOM error");
    expect(result.aggregatedData).toMatchObject({ result: "ok" });
  });

  it("reports 'failed' only when every child failed (zero completed)", async () => {
    setupMocks(fanout({ status: "partial", completedChildren: 0 }), [
      run("sar_1", null, { status: "failed", errorReason: "boom", outputPayload: null }),
      run("sar_2", null, { status: "failed", errorReason: "second", outputPayload: null }),
    ]);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    expect(result.status).toBe("failed");
    expect(result.firstError).toBe("boom");
    expect(result.aggregatedData).toBeNull();
  });

  it("returns 'running' immediately for an in-progress fanout (no blocking poll)", async () => {
    // createdAt is recent, so the snapshot window has not elapsed.
    setupMocks(
      fanout({ status: "running", completedChildren: 1, createdAt: new Date() }),
      [run("sar_1", { a: 1 }), run("sar_2", null, { status: "running", outputPayload: null, completedAt: null })],
    );

    const started = Date.now();
    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 30 * 60 * 1000 },
      CTX,
    );
    // Must return without sleeping for the timeout window.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.status).toBe("running");
    expect(result.aggregatedData).toBeNull();
  });

  it("reports 'timed_out' for an in-progress fanout older than the snapshot window", async () => {
    setupMocks(
      fanout({ status: "running", completedChildren: 1, createdAt: new Date("2020-01-01T00:00:00Z") }),
      [run("sar_1", { a: 1 }), run("sar_2", null, { status: "running", outputPayload: null, completedAt: null })],
    );

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    expect(result.status).toBe("timed_out");
    expect(result.aggregatedData).toBeNull();
  });

  it("throws when fanout is not found", async () => {
    setupMocks(null, []);

    await expect(
      agentSubagentAggregateHandler({ fanoutId: "fan_missing", timeoutMs: 100 }, CTX),
    ).rejects.toThrow("Fanout fan_missing not found");
  });
});
