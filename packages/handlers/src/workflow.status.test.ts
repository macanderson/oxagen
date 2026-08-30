import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  runFindFirst: vi.fn(),
  tasksSelect: vi.fn(),
  tasksFrom: vi.fn(),
  tasksWhere: vi.fn(),
  tasksOrderBy: vi.fn(),
}));

// MOCK_EXECUTION mirrors the shape that agentExecutions.findFirst returns:
//   id, publicId, orgId, workspaceId, status, startedAt, completedAt, createdAt, updatedAt, inputPayload
const MOCK_EXECUTION = {
  id: "wfr-uuid-1",
  publicId: "wfr_ABCDEF",
  orgId: "org-1",
  workspaceId: "ws-1",
  status: "running",
  startedAt: new Date("2026-06-07T00:00:00Z"),
  completedAt: null as Date | null,
  createdAt: new Date("2026-06-07T00:00:00Z"),
  updatedAt: new Date("2026-06-07T00:00:00Z"),
  inputPayload: {
    title: "Fortune 500 research",
    goal: "Profile all Fortune 500 CEOs",
    outputFormat: "json",
    maxParallelism: 50,
    plan: [] as unknown[],
  },
};

// MOCK_STEPS mirrors the agentExecutionSteps row shape:
//   id, publicId, stepNumber, status, inputPayload, outputPayload, failureReason, startedAt, completedAt, createdAt
const MOCK_STEPS = [
  {
    id: "wft-uuid-1",
    publicId: "wft_AAAA",
    orgId: "org-1",
    workspaceId: "ws-1",
    stepNumber: 0,
    stepType: "agent",
    status: "completed",
    inputPayload: { title: "Research CEO #1", goal: "Find CEO of Apple" },
    outputPayload: { summary: "Tim Cook", data: {} },
    failureReason: null as string | null,
    latencyMs: null as number | null,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    startedAt: new Date("2026-06-07T00:01:00Z"),
    completedAt: new Date("2026-06-07T00:02:00Z"),
    createdAt: new Date("2026-06-07T00:00:00Z"),
  },
];

mocks.runFindFirst.mockResolvedValue(MOCK_EXECUTION);
mocks.tasksOrderBy.mockResolvedValue(MOCK_STEPS);
mocks.tasksWhere.mockReturnValue({ orderBy: mocks.tasksOrderBy });
mocks.tasksFrom.mockReturnValue({ where: mocks.tasksWhere });
mocks.tasksSelect.mockReturnValue({ from: mocks.tasksFrom });

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        query: {
          agentExecutions: { findFirst: mocks.runFindFirst },
        },
        select: () => mocks.tasksSelect(),
      };
      return fn(tx);
    },
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { workflowStatusHandler } from "./workflow.status";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workflow.status handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runFindFirst.mockResolvedValue(MOCK_EXECUTION);
    mocks.tasksOrderBy.mockResolvedValue(MOCK_STEPS);
    mocks.tasksWhere.mockReturnValue({ orderBy: mocks.tasksOrderBy });
    mocks.tasksFrom.mockReturnValue({ where: mocks.tasksWhere });
    mocks.tasksSelect.mockReturnValue({ from: mocks.tasksFrom });
  });

  it("throws when workflow not found", async () => {
    mocks.runFindFirst.mockResolvedValueOnce(null);
    await expect(
      workflowStatusHandler({ workflowId: "wfr_NOTEXIST" }, CTX),
    ).rejects.toThrow("workflow not found: wfr_NOTEXIST");
  });

  it("returns workflow row with correct fields", async () => {
    const result = await workflowStatusHandler(
      { workflowId: "wfr_ABCDEF" },
      CTX,
    );
    expect(result.workflow.id).toBe(MOCK_EXECUTION.id);
    expect(result.workflow.publicId).toBe(MOCK_EXECUTION.publicId);
    expect(result.workflow.status).toBe("running");
    // totalTasks and completedTasks are derived from the steps array
    expect(result.workflow.totalTasks).toBe(1);
    expect(result.workflow.completedTasks).toBe(1);
  });

  it("returns tasks array with ISO timestamps", async () => {
    const result = await workflowStatusHandler(
      { workflowId: "wfr-uuid-1" },
      CTX,
    );
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0];
    expect(task?.taskIndex).toBe(0);
    expect(task?.status).toBe("completed");
    expect(task?.startedAt).toBe("2026-06-07T00:01:00.000Z");
  });

  it("returns null timestamps for null date fields", async () => {
    const result = await workflowStatusHandler(
      { workflowId: "wfr-uuid-1" },
      CTX,
    );
    expect(result.workflow.completedAt).toBeNull();
    expect(result.workflow.resultUrl).toBeNull();
  });

  it("serializes createdAt as ISO string", async () => {
    const result = await workflowStatusHandler(
      { workflowId: "wfr-uuid-1" },
      CTX,
    );
    expect(result.workflow.createdAt).toBe("2026-06-07T00:00:00.000Z");
  });
});
