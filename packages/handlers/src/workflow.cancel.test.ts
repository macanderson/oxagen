import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  runFindFirst: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  inngestSend: vi.fn(),
}));

const RUNNING_RUN = { id: "wfr-uuid-1", status: "running" };
const COMPLETED_RUN = { id: "wfr-uuid-2", status: "completed" };
const CANCELLED_RUN = { id: "wfr-uuid-3", status: "cancelled" };

mocks.runFindFirst.mockResolvedValue(RUNNING_RUN);
mocks.updateWhere.mockResolvedValue([{ id: "wfr-uuid-1" }]);
mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/database", () => ({
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      query: {
        workflowRuns: { findFirst: mocks.runFindFirst },
      },
      update: (_table: unknown) => ({ set: mocks.updateSet }),
    };
    return fn(tx);
  },
  schema: {
    workflowRuns: {
      id: "id",
      publicId: "publicId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      status: "status",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  or: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { workflowCancelHandler } from "./workflow.cancel";

const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

describe("workflow.cancel handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runFindFirst.mockResolvedValue(RUNNING_RUN);
    mocks.updateWhere.mockResolvedValue([{ id: "wfr-uuid-1" }]);
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("throws when workflow not found", async () => {
    mocks.runFindFirst.mockResolvedValueOnce(null);
    await expect(
      workflowCancelHandler({ workflowId: "wfr_NOTEXIST" }, CTX),
    ).rejects.toThrow("workflow not found: wfr_NOTEXIST");
  });

  it("returns cancelled:false for already completed workflows", async () => {
    mocks.runFindFirst.mockResolvedValueOnce(COMPLETED_RUN);
    const result = await workflowCancelHandler({ workflowId: "wfr-uuid-2" }, CTX);
    expect(result.cancelled).toBe(false);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns cancelled:false for already cancelled workflows", async () => {
    mocks.runFindFirst.mockResolvedValueOnce(CANCELLED_RUN);
    const result = await workflowCancelHandler({ workflowId: "wfr-uuid-3" }, CTX);
    expect(result.cancelled).toBe(false);
  });

  it("sets status to cancelled and fires inngest event for running workflow", async () => {
    const result = await workflowCancelHandler({ workflowId: "wfr-uuid-1" }, CTX);
    expect(result.cancelled).toBe(true);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent/workflow.cancel",
        data: expect.objectContaining({
          orgId: "org-1",
          workflowRunId: RUNNING_RUN.id,
        }),
      }),
    );
  });

  it("sends the cancel event with the correct workflowRunId", async () => {
    await workflowCancelHandler({ workflowId: "wfr-uuid-1" }, CTX);
    const sendArg = mocks.inngestSend.mock.calls[0][0];
    expect(sendArg.data.workflowRunId).toBe(RUNNING_RUN.id);
  });
});
