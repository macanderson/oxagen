/**
 * actions.test.ts — unit tests for readBackgroundTaskAction.
 *
 * Regression for the silent-failure fix: when the background-task read fails
 * (task not found / capability error / DB error / bad input) the action must
 * NOT throw an unhandled exception into the polling tray (where Promise.allSettled
 * silently drops it, freezing the row forever). It must log with context and
 * return a terminal "failed" snapshot so the user sees the real outcome.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSession, mockInvoke, parseState } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockInvoke: vi.fn(),
  parseState: { ok: true as boolean, message: "Invalid task id" },
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: (_s: unknown, fn: () => unknown) => fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: vi.fn(),
  schema: {},
}));

const mockLoggerError = vi.fn();
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

// Only the background.read contract is exercised here; stub the rest minimally.
vi.mock("@oxagen/oxagen/contracts/chat.message.send", () => ({ chatMessageSend: { input: { safeParse: () => ({ success: true, data: {} }) } } }));
vi.mock("@oxagen/oxagen/contracts/agent.approval.resolve", () => ({ agentApprovalResolve: { input: { safeParse: () => ({ success: true, data: {} }) } } }));
vi.mock("@oxagen/oxagen/contracts/agent.mcp.consent.resolve", () => ({ agentMcpConsentResolve: { input: { safeParse: () => ({ success: true, data: {} }) } } }));
vi.mock("@oxagen/oxagen/contracts/agent.plan.approve", () => ({ agentPlanApprove: { input: { safeParse: () => ({ success: true, data: {} }) } } }));
vi.mock("@oxagen/oxagen/contracts/agent.task.background.cancel", () => ({ agentTaskBackgroundCancel: { input: { safeParse: () => ({ success: true, data: {} }) } } }));
vi.mock("@oxagen/oxagen/contracts/agent.task.background.read", () => ({
  agentTaskBackgroundRead: {
    input: {
      safeParse: (raw: { taskId: string }) =>
        parseState.ok
          ? { success: true, data: raw }
          : { success: false, error: { issues: [{ message: parseState.message }] } },
    },
  },
}));

import { readBackgroundTaskAction } from "./actions";

const CTX = { orgId: "org-1", workspaceId: "ws-1" };
const SESSION = { user: { id: "user-1" } };

describe("readBackgroundTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseState.ok = true;
    mockGetSession.mockResolvedValue(SESSION);
  });

  it("returns the live snapshot on success", async () => {
    mockInvoke.mockResolvedValue({
      taskId: "task-1",
      kind: "research",
      label: "Research task",
      status: "running",
      createdAt: "2026-06-20T00:00:00.000Z",
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
      failureReason: null,
    });

    const snap = await readBackgroundTaskAction(CTX, "task-1");
    expect(snap.status).toBe("running");
    expect(snap.taskId).toBe("task-1");
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("does NOT throw and returns a terminal 'failed' snapshot when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("task not found"));

    const snap = await readBackgroundTaskAction(CTX, "task-gone");

    // Must not propagate — the tray's Promise.allSettled would silently drop it.
    expect(snap.status).toBe("failed");
    expect(snap.taskId).toBe("task-gone");
    expect(snap.failureReason).toBe("task not found");
  });

  it("logs the failure with task + tenant context", async () => {
    const err = new Error("capability error");
    mockInvoke.mockRejectedValue(err);

    await readBackgroundTaskAction(CTX, "task-x");

    expect(mockLoggerError).toHaveBeenCalledWith(
      { err, taskId: "task-x", orgId: "org-1", workspaceId: "ws-1" },
      "[ask] readBackgroundTaskAction failed",
    );
  });

  it("returns a 'failed' snapshot (not a throw) on invalid input", async () => {
    parseState.ok = false;
    parseState.message = "taskId is required";

    const snap = await readBackgroundTaskAction(CTX, "");

    expect(snap.status).toBe("failed");
    expect(snap.failureReason).toBe("taskId is required");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
