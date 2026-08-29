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
import { z } from "zod";

const {
  mockGetSession,
  mockInvoke,
  parseState,
  mockLoggerError,
  mockAssertWorkspaceMember,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockInvoke: vi.fn(),
  parseState: { ok: true as boolean, message: "Invalid task id" },
  mockLoggerError: vi.fn(),
  mockAssertWorkspaceMember: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  assertWorkspaceMember: mockAssertWorkspaceMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: vi.fn(),
  schema: {},
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

// Only the background.read contract is exercised here; stub the rest minimally.
vi.mock("@oxagen/oxagen/contracts/chat.message.send", () => ({
  chatMessageSend: {
    input: { safeParse: () => ({ success: true, data: {} }) },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.approval.resolve", () => ({
  agentApprovalResolve: {
    input: { safeParse: () => ({ success: true, data: {} }) },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.mcp_consent.resolve", () => ({
  agentMcpConsentResolve: {
    input: { safeParse: () => ({ success: true, data: {} }) },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.plan.approve", () => ({
  agentPlanApprove: {
    input: { safeParse: () => ({ success: true, data: {} }) },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.background_task.cancel", () => ({
  agentTaskBackgroundCancel: {
    input: { safeParse: () => ({ success: true, data: {} }) },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.background_task.read", () => ({
  agentTaskBackgroundRead: {
    input: {
      safeParse: (raw: { taskId: string }) =>
        parseState.ok
          ? { success: true, data: raw }
          : {
              success: false,
              error: { issues: [{ message: parseState.message }] },
            },
    },
  },
}));

import { readBackgroundTaskAction } from "./actions";
import { parseAttachmentsField } from "./parse-attachments";

const CTX = { orgId: "org-1", workspaceId: "ws-1" };
const SESSION = { user: { id: "user-1" } };

describe("readBackgroundTaskAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseState.ok = true;
    mockGetSession.mockResolvedValue(SESSION);
    mockAssertWorkspaceMember.mockResolvedValue(undefined);
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

  it("asserts workspace membership before doing anything", async () => {
    mockInvoke.mockResolvedValue({
      taskId: "task-1",
      kind: "research",
      label: null,
      status: "running",
      createdAt: "2026-06-20T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      failureReason: null,
    });
    await readBackgroundTaskAction(CTX, "task-1");
    expect(mockAssertWorkspaceMember).toHaveBeenCalledWith("ws-1", "user-1");
  });

  it("denies a non-member: propagates the gate rejection and never reaches invoke (IDOR guard)", async () => {
    // assertWorkspaceMember calls notFound() for a non-member, which throws.
    // The gate runs before the try/catch, so it propagates (a non-member must
    // get 404, not a fabricated 'failed' snapshot).
    mockAssertWorkspaceMember.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(readBackgroundTaskAction(CTX, "task-1")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("parseAttachmentsField", () => {
  it("returns [] when the field is undefined", () => {
    expect(parseAttachmentsField(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseAttachmentsField("")).toEqual([]);
  });

  it("returns [] for malformed JSON instead of throwing", () => {
    expect(parseAttachmentsField("{ not json")).toEqual([]);
  });

  it("parses a valid JSON array of attachment refs", () => {
    const attachments = [
      {
        publicId: "gen_abc",
        kind: "image",
        name: "photo.png",
        mimeType: "image/png",
        url: "/api/v1/assets/gen_abc",
      },
    ];
    expect(parseAttachmentsField(JSON.stringify(attachments))).toEqual(
      attachments,
    );
  });

  it("returns [] for a non-string FormDataEntryValue (e.g. a File)", () => {
    const file = new File(["x"], "photo.png", { type: "image/png" });
    expect(parseAttachmentsField(file)).toEqual([]);
  });

  // parseAttachmentsField's sole caller feeds the result straight into a
  // SYNCHRONOUS `FormSchema.safeParse`, so an async (Promise-returning)
  // implementation would reach `z.array()` as `received: "promise"` and fail
  // every text-only message send with "Invalid message". Guard: the helper
  // must return synchronously (never a thenable) AND the value must validate
  // against the same `z.array()` shape the send action uses.
  it("returns synchronously (not a Promise) so FormSchema.safeParse sees an array, not a promise", () => {
    const attachmentSchema = z.object({
      publicId: z.string().min(1),
      kind: z.string().min(1),
      name: z.string().min(1),
      mimeType: z.string().min(1),
      url: z.string().min(1),
    });
    const attachmentsField = z.array(attachmentSchema).max(8).default([]);

    for (const raw of [undefined, "", "[]", "{ not json"] as const) {
      const value = parseAttachmentsField(raw);
      // A thenable would slip past z.array() and fail the whole send.
      expect(typeof (value as { then?: unknown })?.then).not.toBe("function");
      const parsed = attachmentsField.safeParse(value);
      expect(parsed.success).toBe(true);
    }
  });
});
