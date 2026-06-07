import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  inngestSend: vi.fn(),
}));

const NOW = new Date("2026-06-07T00:00:00.000Z");
const ROW = { id: "wfr-uuid-1", publicId: "wfr_ABCDEF" };

mocks.insertReturning.mockResolvedValue([ROW]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/database", () => ({
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: (_table: unknown) => ({ values: mocks.insertValues }),
    };
    return fn(tx);
  },
  schema: {
    workflowRuns: {
      id: "id",
      publicId: "publicId",
      orgId: "orgId",
      workspaceId: "workspaceId",
    },
  },
}));

vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { workflowRunHandler } from "./workflow.run";

const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

describe("workflow.run handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertReturning.mockResolvedValue([ROW]);
    mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("rejects when no userId in context", async () => {
    await expect(
      workflowRunHandler({ goal: "Profile Fortune 500 CEOs" }, { ...CTX, userId: null }),
    ).rejects.toThrow("workflow.run requires an authenticated user");
  });

  it("inserts a workflow_runs row and fires inngest event", async () => {
    const result = await workflowRunHandler(
      { goal: "Profile Fortune 500 CEOs" },
      CTX,
    );

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent/workflow.supervisor.start",
        data: expect.objectContaining({
          orgId: "org-1",
          workspaceId: "ws-1",
          workflowRunId: ROW.id,
        }),
      }),
    );
    expect(result.workflowId).toBe(ROW.id);
    expect(result.publicId).toBe(ROW.publicId);
    expect(result.status).toBe("planning");
  });

  it("returns a render directive for workflow-progress", async () => {
    const result = await workflowRunHandler({ goal: "test goal" }, CTX);
    expect(result.render.componentId).toBe("workflow-progress");
    expect(result.render.props.workflowId).toBe(ROW.id);
  });

  it("uses input title when provided", async () => {
    await workflowRunHandler({ goal: "test goal", title: "My Workflow" }, CTX);
    const insertCall = mocks.insertValues.mock.calls[0][0];
    expect(insertCall.title).toBe("My Workflow");
  });

  it("truncates goal to 200 chars as title when title omitted", async () => {
    const longGoal = "A".repeat(300);
    await workflowRunHandler({ goal: longGoal }, CTX);
    const insertCall = mocks.insertValues.mock.calls[0][0];
    expect(insertCall.title.length).toBe(200);
  });

  it("forwards maxParallelism to inngest payload", async () => {
    await workflowRunHandler({ goal: "test", maxParallelism: 10 }, CTX);
    const sendCall = mocks.inngestSend.mock.calls[0][0];
    expect(sendCall.data.maxParallelism).toBe(10);
  });

  it("throws when insert returns no row", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    await expect(
      workflowRunHandler({ goal: "test" }, CTX),
    ).rejects.toThrow("workflow.run: insert returned no row");
  });
});
