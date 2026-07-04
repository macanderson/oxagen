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

const {
  mockGetSession,
  mockInvoke,
  parseState,
  mockLoggerError,
  mockAssertWorkspaceMember,
  mockWithTenantDb,
  FAKE_CONVERSATIONS_TABLE,
  FAKE_MESSAGES_TABLE,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockInvoke: vi.fn(),
  parseState: { ok: true as boolean, message: "Invalid task id" },
  mockLoggerError: vi.fn(),
  mockAssertWorkspaceMember: vi.fn(),
  mockWithTenantDb: vi.fn(),
  // Distinguishable table tokens — sendMessageAction's tx.insert/select/update
  // calls pass these as their first arg, so the fake tx (built per-test below)
  // can tell a conversations write from a messages write without a real schema.
  FAKE_CONVERSATIONS_TABLE: { __table: "conversations" },
  FAKE_MESSAGES_TABLE: { __table: "messages" },
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({ assertWorkspaceMember: mockAssertWorkspaceMember }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: (_s: unknown, fn: () => unknown) => fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: {
    conversations: FAKE_CONVERSATIONS_TABLE,
    messages: FAKE_MESSAGES_TABLE,
  },
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

// Only the background.read contract is exercised here; stub the rest minimally.
// chatMessageSend's safeParse echoes the input back with the same defaults the
// real contract applies (contentBlocks/attachments default to []) — the
// contract's own validation rules are exercised by chat.message.send.test.ts;
// this file exercises sendMessageAction's own logic (attachments JSON parsing,
// metadata persistence), which needs realistic .data, not a fixed stub.
vi.mock("@oxagen/oxagen/contracts/chat.message.send", () => ({
  chatMessageSend: {
    input: {
      safeParse: (input: Record<string, unknown>) => ({
        success: true,
        data: {
          conversationId: input.conversationId ?? null,
          parentMessageId: input.parentMessageId ?? null,
          branchReason: input.branchReason ?? null,
          content: input.content,
          contentBlocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : [],
          attachments: Array.isArray(input.attachments) ? input.attachments : [],
        },
      }),
    },
  },
}));
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

import { readBackgroundTaskAction, sendMessageAction } from "./actions";

const CTX = { orgId: "org-1", workspaceId: "ws-1" };
const FULL_CTX = { orgSlug: "acme", workspaceSlug: "main", ...CTX };
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
    await expect(readBackgroundTaskAction(CTX, "task-1")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

/**
 * A minimal fake Drizzle transaction: every builder method returns the same
 * `this` (chainable) and the final call resolves via `.then()`. Distinguishes
 * a conversations write/read from a messages write by the table token
 * (FAKE_CONVERSATIONS_TABLE / FAKE_MESSAGES_TABLE) passed as insert()/from()'s
 * first arg — sendMessageAction never inspects the token itself, only Drizzle
 * would, and Drizzle is fully replaced here.
 */
function makeFakeTx(opts: {
  existingConversation?: { id: string; publicId: string; leaf: string | null } | null;
  newConversation?: { id: string; publicId: string };
  newMessage?: { id: string };
  capturedMessageValues: Record<string, unknown>[];
}) {
  const { existingConversation = null, newConversation, newMessage, capturedMessageValues } = opts;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existingConversation ? [existingConversation] : []),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: () => {
          if (table === FAKE_MESSAGES_TABLE) {
            capturedMessageValues.push(vals);
            return Promise.resolve([newMessage]);
          }
          return Promise.resolve([newConversation]);
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  };
}

describe("sendMessageAction", () => {
  let capturedMessageValues: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageValues = [];
    mockGetSession.mockResolvedValue(SESSION);
    mockAssertWorkspaceMember.mockResolvedValue(undefined);
  });

  const ATTACHMENT = {
    publicId: "gen_abc",
    kind: "image",
    name: "cat.png",
    mimeType: "image/png",
    url: "/api/v1/assets/gen_abc",
    sizeBytes: 2048,
  };

  function newConversationFormData(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it("persists attachments onto the user message's metadata for a new conversation", async () => {
    mockWithTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeFakeTx({
          newConversation: { id: "conv-1", publicId: "cnv_1" },
          newMessage: { id: "msg-1" },
          capturedMessageValues,
        }),
      ),
    );

    const result = await sendMessageAction(
      FULL_CTX,
      newConversationFormData({
        content: "look at this",
        attachments: JSON.stringify([ATTACHMENT]),
      }),
    );

    expect(result.ok).toBe(true);
    expect(capturedMessageValues).toHaveLength(1);
    expect(capturedMessageValues[0]?.metadata).toEqual({ attachments: [ATTACHMENT] });
  });

  it("persists an empty metadata object when no attachments are sent", async () => {
    mockWithTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeFakeTx({
          newConversation: { id: "conv-1", publicId: "cnv_1" },
          newMessage: { id: "msg-1" },
          capturedMessageValues,
        }),
      ),
    );

    const result = await sendMessageAction(FULL_CTX, newConversationFormData({ content: "hello" }));

    expect(result.ok).toBe(true);
    expect(capturedMessageValues[0]?.metadata).toEqual({});
  });

  it("threads attachments onto an existing conversation's active leaf", async () => {
    mockWithTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeFakeTx({
          existingConversation: { id: "conv-1", publicId: "cnv_1", leaf: "msg-0" },
          newMessage: { id: "msg-2" },
          capturedMessageValues,
        }),
      ),
    );

    const result = await sendMessageAction(
      FULL_CTX,
      newConversationFormData({
        content: "another one",
        conversationId: "conv-1",
        attachments: JSON.stringify([ATTACHMENT]),
      }),
    );

    expect(result.ok).toBe(true);
    expect(capturedMessageValues[0]?.parentMessageId).toBe("msg-0");
    expect(capturedMessageValues[0]?.metadata).toEqual({ attachments: [ATTACHMENT] });
  });

  it("returns ok:false and never touches the DB when the attachments field is malformed JSON", async () => {
    const result = await sendMessageAction(
      FULL_CTX,
      newConversationFormData({ content: "hi", attachments: "{not json" }),
    );

    expect(result).toEqual({ ok: false, error: "Invalid attachments" });
    expect(mockWithTenantDb).not.toHaveBeenCalled();
  });

  it("asserts workspace membership before touching the DB", async () => {
    mockWithTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(
        makeFakeTx({
          newConversation: { id: "conv-1", publicId: "cnv_1" },
          newMessage: { id: "msg-1" },
          capturedMessageValues,
        }),
      ),
    );

    await sendMessageAction(FULL_CTX, newConversationFormData({ content: "hi" }));
    expect(mockAssertWorkspaceMember).toHaveBeenCalledWith("ws-1", "user-1");
  });
});
