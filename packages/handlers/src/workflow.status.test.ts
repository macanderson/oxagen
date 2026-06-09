import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  runFindFirst: vi.fn(),
  tasksSelect: vi.fn(),
  tasksFrom: vi.fn(),
  tasksWhere: vi.fn(),
  tasksOrderBy: vi.fn(),
}));

const MOCK_RUN = {
  id: "wfr-uuid-1",
  publicId: "wfr_ABCDEF",
  orgId: "org-1",
  workspaceId: "ws-1",
  title: "Fortune 500 research",
  goal: "Profile all Fortune 500 CEOs",
  status: "running",
  planJson: [],
  totalTasks: 10,
  completedTasks: 3,
  failedTasks: 0,
  maxParallelism: 50,
  outputFormat: "json",
  resultUrl: null,
  startedAt: new Date("2026-06-07T00:00:00Z"),
  completedAt: null,
  createdAt: new Date("2026-06-07T00:00:00Z"),
  updatedAt: new Date("2026-06-07T00:00:00Z"),
};

const MOCK_TASKS = [
  {
    id: "wft-uuid-1",
    publicId: "wft_AAAA",
    workflowRunId: "wfr-uuid-1",
    orgId: "org-1",
    workspaceId: "ws-1",
    taskIndex: 0,
    title: "Research CEO #1",
    goal: "Find CEO of Apple",
    status: "completed",
    inngestRunId: "inngest-run-1",
    outputJson: { summary: "Tim Cook", data: {} },
    error: null,
    startedAt: new Date("2026-06-07T00:01:00Z"),
    completedAt: new Date("2026-06-07T00:02:00Z"),
    createdAt: new Date("2026-06-07T00:00:00Z"),
  },
];

mocks.runFindFirst.mockResolvedValue(MOCK_RUN);
mocks.tasksOrderBy.mockResolvedValue(MOCK_TASKS);
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
        workflowRuns: { findFirst: mocks.runFindFirst },
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
    mocks.runFindFirst.mockResolvedValue(MOCK_RUN);
    mocks.tasksOrderBy.mockResolvedValue(MOCK_TASKS);
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
    const result = await workflowStatusHandler({ workflowId: "wfr_ABCDEF" }, CTX);
    expect(result.workflow.id).toBe(MOCK_RUN.id);
    expect(result.workflow.publicId).toBe(MOCK_RUN.publicId);
    expect(result.workflow.status).toBe("running");
    expect(result.workflow.totalTasks).toBe(10);
    expect(result.workflow.completedTasks).toBe(3);
  });

  it("returns tasks array with ISO timestamps", async () => {
    const result = await workflowStatusHandler({ workflowId: "wfr-uuid-1" }, CTX);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0];
    expect(task?.taskIndex).toBe(0);
    expect(task?.status).toBe("completed");
    expect(task?.startedAt).toBe("2026-06-07T00:01:00.000Z");
  });

  it("returns null timestamps for null date fields", async () => {
    const result = await workflowStatusHandler({ workflowId: "wfr-uuid-1" }, CTX);
    expect(result.workflow.completedAt).toBeNull();
    expect(result.workflow.resultUrl).toBeNull();
  });

  it("serializes createdAt as ISO string", async () => {
    const result = await workflowStatusHandler({ workflowId: "wfr-uuid-1" }, CTX);
    expect(result.workflow.createdAt).toBe("2026-06-07T00:00:00.000Z");
  });
});
