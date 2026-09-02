import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  inngestSend: vi.fn(),
}));

const ROW = { id: "aex-uuid-1", publicId: "aex_ABCDEF" };

mocks.insertReturning.mockResolvedValue([ROW]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (_table: unknown) => ({ values: mocks.insertValues }),
      };
      return fn(tx);
    },
  };
});

vi.mock("./event-client", () => ({
  eventClient: { send: mocks.inngestSend },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { workflowRunHandler } from "./workflow.run";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workflow.run handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertReturning.mockResolvedValue([ROW]);
    mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  const BASE_INPUT = {
    goal: "Profile Fortune 500 CEOs",
    outputFormat: "json" as const,
    maxParallelism: 50,
  };

  it("rejects when no userId in context", async () => {
    await expect(
      workflowRunHandler(BASE_INPUT, { ...CTX, userId: null }),
    ).rejects.toThrow("workflow.run requires an authenticated user");
  });

  it("inserts an agent_executions row and fires inngest event", async () => {
    const result = await workflowRunHandler(BASE_INPUT, CTX);

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent/workflow.supervisor.start",
        data: expect.objectContaining({
          orgId: "org_1",
          workspaceId: "ws_1",
          executionId: ROW.id,
        }),
      }),
    );
    expect(result.workflowId).toBe(ROW.id);
    expect(result.publicId).toBe(ROW.publicId);
    expect(result.status).toBe("planning");
  });

  it("inserts origin_type='workflow_run' (underscore) to satisfy the agent_executions CHECK constraint", async () => {
    // Regression: the handler previously inserted "workflow.run" (dot), which
    // the agent_executions_origin_type_check CHECK rejects, so every real
    // workflow run failed at INSERT. The DB mock can't catch the violation, so
    // assert the literal value explicitly.
    await workflowRunHandler(BASE_INPUT, CTX);
    const insertCall = mocks.insertValues.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertCall.originType).toBe("workflow_run");
  });

  it("returns a render directive for workflow-progress", async () => {
    const result = await workflowRunHandler(BASE_INPUT, CTX);
    expect(result.render.componentId).toBe("workflow-progress");
    expect(result.render.props.workflowId).toBe(ROW.id);
  });

  it("uses input title when provided", async () => {
    await workflowRunHandler({ ...BASE_INPUT, title: "My Workflow" }, CTX);
    const insertCall = mocks.insertValues.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect((insertCall.inputPayload as Record<string, unknown>).title).toBe(
      "My Workflow",
    );
  });

  it("truncates goal to 200 chars as title when title omitted", async () => {
    const longGoal = "A".repeat(300);
    await workflowRunHandler({ ...BASE_INPUT, goal: longGoal }, CTX);
    const insertCall = mocks.insertValues.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const payload = insertCall.inputPayload as Record<string, unknown>;
    expect((payload.title as string).length).toBe(200);
  });

  it("forwards maxParallelism to inngest payload", async () => {
    await workflowRunHandler({ ...BASE_INPUT, maxParallelism: 10 }, CTX);
    const sendCall = mocks.inngestSend.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect((sendCall.data as Record<string, unknown>).maxParallelism).toBe(10);
  });

  it("throws when insert returns no row", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    await expect(workflowRunHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "workflow.run: insert returned no row",
    );
  });
});
