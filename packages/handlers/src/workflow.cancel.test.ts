import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  runFindFirst: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateReturning: vi.fn(),
  inngestSend: vi.fn(),
}));

const RUNNING_RUN = { id: "wfr-uuid-1", status: "running" };
const COMPLETED_RUN = { id: "wfr-uuid-2", status: "completed" };
const CANCELLED_RUN = { id: "wfr-uuid-3", status: "cancelled" };

mocks.runFindFirst.mockResolvedValue(RUNNING_RUN);
// The guarded UPDATE only flips a still-cancellable row; .returning() yields the
// flipped row in that case. Default: one row flipped (running -> cancelled).
mocks.updateReturning.mockResolvedValue([{ id: "wfr-uuid-1" }]);
mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning });
mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
mocks.inngestSend.mockResolvedValue(undefined);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        query: {
          agentExecutions: { findFirst: mocks.runFindFirst },
        },
        update: (_table: unknown) => ({ set: mocks.updateSet }),
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

import { workflowCancelHandler } from "./workflow.cancel";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workflow.cancel handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runFindFirst.mockResolvedValue(RUNNING_RUN);
    mocks.updateReturning.mockResolvedValue([{ id: "wfr-uuid-1" }]);
    mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning });
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
    // Guarded UPDATE flips no row for a terminal status.
    mocks.updateReturning.mockResolvedValueOnce([]);
    const result = await workflowCancelHandler(
      { workflowId: "wfr-uuid-2" },
      CTX,
    );
    expect(result.cancelled).toBe(false);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns cancelled:false for already cancelled workflows", async () => {
    mocks.runFindFirst.mockResolvedValueOnce(CANCELLED_RUN);
    mocks.updateReturning.mockResolvedValueOnce([]);
    const result = await workflowCancelHandler(
      { workflowId: "wfr-uuid-3" },
      CTX,
    );
    expect(result.cancelled).toBe(false);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("does not corrupt a run that transitions to completed mid-cancel (TOCTOU)", async () => {
    // The existence read still sees the run as running, but the guarded UPDATE
    // flips zero rows because the worker raced it to a terminal status. The
    // handler must report cancelled:false and emit no cancel event rather than
    // overwriting the terminal state.
    mocks.runFindFirst.mockResolvedValueOnce(RUNNING_RUN);
    mocks.updateReturning.mockResolvedValueOnce([]);
    const result = await workflowCancelHandler(
      { workflowId: "wfr-uuid-1" },
      CTX,
    );
    expect(result.cancelled).toBe(false);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("sets status to cancelled and fires inngest event for running workflow", async () => {
    const result = await workflowCancelHandler(
      { workflowId: "wfr-uuid-1" },
      CTX,
    );
    expect(result.cancelled).toBe(true);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent/workflow.cancel",
        data: expect.objectContaining({
          orgId: "org_1",
          executionId: RUNNING_RUN.id,
        }),
      }),
    );
  });

  it("sends the cancel event with the correct executionId", async () => {
    await workflowCancelHandler({ workflowId: "wfr-uuid-1" }, CTX);
    const sendArg = mocks.inngestSend.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect((sendArg.data as Record<string, unknown>).executionId).toBe(
      RUNNING_RUN.id,
    );
  });
});
