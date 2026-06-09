import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Module mocks -----------------------------------------------------------

vi.mock("@oxagen/database", () => ({
  withTenantDb: vi.fn(),
  schema: {
    subagentFanouts: {
      publicId: "fan.publicId",
      status: "fan.status",
      totalChildren: "fan.totalChildren",
      completedChildren: "fan.completedChildren",
      orgId: "fan.orgId",
      workspaceId: "fan.workspaceId",
    },
    subagentRuns: {
      publicId: "run.publicId",
      capabilityName: "run.capabilityName",
      status: "run.status",
      outputPayload: "run.outputPayload",
      errorReason: "run.errorReason",
      startedAt: "run.startedAt",
      completedAt: "run.completedAt",
      fanoutId: "run.fanoutId",
      orgId: "run.orgId",
      workspaceId: "run.workspaceId",
    },
  },
}));

import { withTenantDb } from "@oxagen/database";
import { agentSubagentAggregateHandler } from "./agent.subagent.aggregate";

// ---- Test helpers -----------------------------------------------------------

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

type FanoutRow = { publicId: string; status: string; totalChildren: number; completedChildren: number };
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
  return { publicId: "fan_1", status: "completed", totalChildren: 2, completedChildren: 2, ...overrides };
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

  it("returns failed status and firstError when any child run failed", async () => {
    setupMocks(fanout({ status: "partial" }), [
      run("sar_1", { result: "ok" }),
      run("sar_2", null, { status: "failed", errorReason: "OOM error", outputPayload: null }),
    ]);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_1", timeoutMs: 1000 },
      CTX,
    );

    expect(result.status).toBe("failed");
    expect(result.firstError).toBe("OOM error");
    expect(result.aggregatedData).toBeNull();
    expect(result.conflicts).toHaveLength(0);
  });

  it("throws when fanout is not found", async () => {
    setupMocks(null, []);

    await expect(
      agentSubagentAggregateHandler({ fanoutId: "fan_missing", timeoutMs: 100 }, CTX),
    ).rejects.toThrow("Fanout fan_missing not found");
  });
});
