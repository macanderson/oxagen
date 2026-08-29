/**
 * shell-actions.test.ts — unit tests for org-level shell server actions.
 *
 * Covers the stub actions (which always return ok:false) and the core
 * branching logic of wandSendAction and wandResolveApprovalAction / wandResolvePlanAction.
 *
 * The stub actions (orgShellSendAction, orgShellResolveApprovalAction,
 * orgShellResolvePlanAction) are synchronous no-ops by design. Their
 * contracts are tested here so regressions are caught.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockRunInTenantScope,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    orgRows: Array<{ id: string }>;
    wsRows: Array<{ id: string }>;
    convRows: Array<{ id: string; publicId: string; leaf: string | null }>;
    msgRows: Array<{ id: string }>;
    // Rows returned by the workspace-membership SELECT (workspace.workspace_users).
    // A non-empty array => caller IS a member; empty => not a member.
    wsUserRows: Array<{ id: string }>;
    // Tracks global withSystemDb call count — resolveWorkspaceFromSlugs makes
    // two separate withSystemDb calls: org lookup (odd calls) + ws lookup (even calls).
    // Reset in beforeEach so each test starts fresh.
    systemCallIdx: number;
    // Tracks tenant-DB SELECT order: 1st select in wandSendAction is the
    // membership check, subsequent selects are the conversation lookup.
    tenantSelectIdx: number;
    // Tracks tenant-DB INSERT order: 1st insert is the conversation, 2nd the message.
    tenantInsertIdx: number;
    // When set, the workspace-membership SELECT (1st tenant select) rejects with
    // this error — simulates an RLS / tenancy failure so we can assert the
    // membership check logs and fails closed.
    membershipError: unknown;
  }
  const dbState: DbState = {
    orgRows: [{ id: "org-1" }],
    wsRows: [{ id: "ws-1" }],
    convRows: [],
    msgRows: [{ id: "msg-1" }],
    wsUserRows: [{ id: "wu-1" }],
    systemCallIdx: 0,
    tenantSelectIdx: 0,
    tenantInsertIdx: 0,
    membershipError: null,
  };

  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );

  return {
    mockGetSession: vi.fn(),
    mockRunInTenantScope,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));

// Logger mock — assert the membership-check failure path logs before failing closed.
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@oxagen/handlers/logger", () => ({ logger: loggerMock }));

// withSystemDb routes — first call resolves org, second resolves workspace.
// Uses dbState.systemCallIdx (reset in beforeEach) to track global call order.
// withTenantDb routes — conversation + message inserts.
vi.mock("@oxagen/database", () => {
  const makeSystemTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => {
            dbState.systemCallIdx++;
            if (dbState.systemCallIdx % 2 === 1)
              return Promise.resolve(dbState.orgRows);
            return Promise.resolve(dbState.wsRows);
          },
        }),
      }),
    }),
  });

  const makeTenantTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => {
        // Tenant SELECT order:
        //   1 — workspace-membership check (wsUserRows)
        //   2 — conversation lookup (convRows)
        //   3 — message history walk (msgRows; loadAgentConversationAction only)
        const limit = (_n: number) => {
          dbState.tenantSelectIdx++;
          if (dbState.tenantSelectIdx === 1) {
            if (dbState.membershipError)
              return Promise.reject(dbState.membershipError);
            return Promise.resolve(dbState.wsUserRows);
          }
          if (dbState.tenantSelectIdx === 3)
            return Promise.resolve(dbState.msgRows);
          return Promise.resolve(dbState.convRows);
        };
        return {
          where: (_w: unknown) => ({
            limit,
            // loadAgentConversationAction's message query orders before limiting.
            orderBy: (_o: unknown) => ({ limit }),
          }),
        };
      },
    }),
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => ({
        returning: () => {
          // wandSendAction inserts the conversation first (when no
          // conversationId was supplied) then the user message. Track order so
          // the conversation row carries a publicId and the message row an id.
          dbState.tenantInsertIdx++;
          if (dbState.tenantInsertIdx === 1 && dbState.convRows.length === 0) {
            return Promise.resolve([{ id: "conv-1", publicId: "pub-1" }]);
          }
          return Promise.resolve(dbState.msgRows);
        },
      }),
    }),
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_w: unknown) => Promise.resolve(undefined),
      }),
    }),
  });

  return {
    withSystemDb: vi.fn(
      (fn: (tx: ReturnType<typeof makeSystemTx>) => unknown) => {
        // Do NOT reset systemCallIdx here — the helper makes two separate
        // withSystemDb calls (org then ws) and the counter must survive both.
        return fn(makeSystemTx());
      },
    ),
    withTenantDb: vi.fn(
      (fn: (tx: ReturnType<typeof makeTenantTx>) => unknown) =>
        fn(makeTenantTx()),
    ),
    schema: {
      organizations: { id: "org_id", slug: "org_slug" },
      workspaces: { id: "ws_id", orgId: "ws_orgId", slug: "ws_slug" },
      workspaceUsers: {
        id: "wu_id",
        workspaceId: "wu_wsId",
        userId: "wu_userId",
      },
      conversations: {
        id: "conv_id",
        publicId: "conv_pid",
        orgId: "conv_orgId",
        workspaceId: "conv_wsId",
        activeLeafMessageId: "conv_leaf",
      },
      messages: {
        id: "msg_id",
        orgId: "msg_orgId",
        workspaceId: "msg_wsId",
        conversationId: "msg_convId",
      },
    },
  };
});

// Mock contracts
vi.mock("@oxagen/oxagen/contracts/chat.message.send", () => ({
  chatMessageSend: {
    input: {
      safeParse: (raw: unknown) => {
        const r = raw as { content?: unknown };
        if (!r?.content)
          return {
            success: false,
            error: { issues: [{ message: "Invalid" }] },
          };
        return {
          success: true,
          data: {
            conversationId: null,
            parentMessageId: null,
            branchReason: null,
            content: r.content,
            contentBlocks: [],
          },
        };
      },
    },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.approval.resolve", () => ({
  agentApprovalResolve: {
    input: {
      safeParse: (raw: unknown) => {
        const r = raw as { approvalId?: unknown; decision?: unknown };
        if (!r?.approvalId || !r?.decision)
          return {
            success: false,
            error: { issues: [{ message: "Invalid" }] },
          };
        return { success: true, data: r };
      },
    },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.mcp_consent.resolve", () => ({
  agentMcpConsentResolve: {
    input: {
      safeParse: (raw: unknown) => {
        const r = raw as {
          approvalId?: unknown;
          decision?: unknown;
          grantAllTools?: unknown;
        };
        if (!r?.approvalId || !r?.decision)
          return {
            success: false,
            error: { issues: [{ message: "Invalid" }] },
          };
        return { success: true, data: r };
      },
    },
  },
}));
vi.mock("@oxagen/oxagen/contracts/agent.plan.approve", () => ({
  agentPlanApprove: {
    input: {
      safeParse: (raw: unknown) => {
        const r = raw as { planId?: unknown; decision?: unknown };
        if (!r?.planId || !r?.decision)
          return {
            success: false,
            error: { issues: [{ message: "Invalid" }] },
          };
        return { success: true, data: r };
      },
    },
  },
}));

import {
  wandSendAction,
  wandResolveApprovalAction,
  wandResolveConsentAction,
  wandResolvePlanAction,
  loadAgentConversationAction,
} from "./shell-actions";

const SESSION = { user: { id: "user-1" } };

/** Build the FormData payload wandSendAction expects. */
function sendFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("orgSlug", "acme");
  fd.set("workspaceSlug", "main");
  fd.set("content", "hello");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

// ---------------------------------------------------------------------------
// Tests — wandSendAction workspace-membership gate (IDOR regression)
//
// The membership gate previously returned `true` for ANY caller whenever the
// DB query succeeded (the bug discarded the row count). These tests prove the
// gate now denies non-members and admits real members.
// ---------------------------------------------------------------------------

describe("wandSendAction — workspace membership gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgRows = [{ id: "org-1" }];
    dbState.wsRows = [{ id: "ws-1" }];
    dbState.convRows = [];
    dbState.msgRows = [{ id: "msg-1" }];
    dbState.wsUserRows = [{ id: "wu-1" }];
    dbState.systemCallIdx = 0;
    dbState.tenantSelectIdx = 0;
    dbState.tenantInsertIdx = 0;
    dbState.membershipError = null;
    mockGetSession.mockResolvedValue(SESSION);
  });

  it("logs and treats the caller as a non-member when the membership check errors (RLS / tenancy failure)", async () => {
    dbState.membershipError = new Error("RLS denied");
    const res = await wandSendAction(sendFormData());
    // Fail closed — the error must not grant access.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("access");
    // …but the failure is observable, not silent.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1" }),
      expect.stringContaining("workspace membership check errored"),
    );
  });

  it("denies a non-member (zero membership rows) — no cross-workspace write", async () => {
    dbState.wsUserRows = [];
    const res = await wandSendAction(sendFormData());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("access");
  });

  it("admits a real member (membership row present) and creates the message", async () => {
    dbState.wsUserRows = [{ id: "wu-1" }];
    const res = await wandSendAction(sendFormData());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.userMessageId).toBe("msg-1");
      expect(res.conversationId).toBeTruthy();
    }
  });

  it("denies when the workspace cannot be resolved from slugs", async () => {
    dbState.wsRows = [];
    const res = await wandSendAction(sendFormData());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Workspace not found");
  });
});

// ---------------------------------------------------------------------------
// Tests — wandResolveApprovalAction
// ---------------------------------------------------------------------------

describe("wandResolveApprovalAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgRows = [{ id: "org-1" }];
    dbState.wsRows = [{ id: "ws-1" }];
    dbState.wsUserRows = [{ id: "wu-1" }];
    dbState.systemCallIdx = 0;
    dbState.tenantSelectIdx = 0;
    dbState.membershipError = null;
    mockGetSession.mockResolvedValue(SESSION);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false when workspace cannot be resolved (empty org rows)", async () => {
    dbState.orgRows = [];
    const res = await wandResolveApprovalAction(
      "acme",
      "main",
      "appr-1",
      "approved",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("workspace");
  });

  // Regression: wandResolveApprovalAction resolved orgSlug/workspaceSlug to
  // real ids but never asserted the caller
  // was actually a member of that workspace before invoking
  // agent.approval.resolve — invoke() from apps/app skips the kernel IAM
  // check, so any authenticated user who knew/guessed an orgSlug +
  // workspaceSlug + approvalId could resolve (approve/deny) an approval in a
  // workspace they don't belong to. This proves the gate now denies them.
  it("denies a non-member — no cross-workspace approval resolution", async () => {
    dbState.wsUserRows = [];
    const res = await wandResolveApprovalAction(
      "acme",
      "main",
      "appr-1",
      "approved",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("access");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls invoke for a valid approval", async () => {
    const res = await wandResolveApprovalAction(
      "acme",
      "main",
      "appr-1",
      "approved",
    );
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "resolve_approval",
      expect.objectContaining({ approvalId: "appr-1", decision: "approved" }),
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("approval expired"));
    const res = await wandResolveApprovalAction(
      "acme",
      "main",
      "appr-1",
      "denied",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("approval expired");
  });
});

// ---------------------------------------------------------------------------
// Tests — wandResolveConsentAction
// ---------------------------------------------------------------------------

describe("wandResolveConsentAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgRows = [{ id: "org-1" }];
    dbState.wsRows = [{ id: "ws-1" }];
    dbState.wsUserRows = [{ id: "wu-1" }];
    dbState.systemCallIdx = 0;
    dbState.tenantSelectIdx = 0;
    dbState.membershipError = null;
    mockGetSession.mockResolvedValue(SESSION);
    mockInvoke.mockResolvedValue(undefined);
  });

  // Regression: same missing-membership-gate bug as wandResolveApprovalAction,
  // for the MCP first-use consent resolver.
  it("denies a non-member — no cross-workspace consent resolution", async () => {
    dbState.wsUserRows = [];
    const res = await wandResolveConsentAction(
      "acme",
      "main",
      "appr-1",
      "granted",
      false,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("access");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true and calls invoke for a valid member", async () => {
    const res = await wandResolveConsentAction(
      "acme",
      "main",
      "appr-1",
      "granted",
      true,
    );
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "resolve_mcp_consent",
      expect.objectContaining({
        approvalId: "appr-1",
        decision: "granted",
        grantAllTools: true,
      }),
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — wandResolvePlanAction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests — loadAgentConversationAction
//
// The floating in-app agent panel calls this after each turn to reload the
// persisted active branch (it has no RSC to refresh). These tests prove it
// gates on membership, walks the active branch into ChatMessages, and degrades
// gracefully when the conversation isn't found.
// ---------------------------------------------------------------------------

describe("loadAgentConversationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgRows = [{ id: "org-1" }];
    dbState.wsRows = [{ id: "ws-1" }];
    dbState.wsUserRows = [{ id: "wu-1" }];
    // Conversation lookup (2nd tenant select) returns one row with a leaf.
    dbState.convRows = [
      { id: "conv-1", publicId: "pub-1", leaf: "m2" } as unknown as {
        id: string;
        publicId: string;
        leaf: string | null;
      },
    ];
    // Message history (3rd tenant select) — a user→assistant branch.
    dbState.msgRows = [
      {
        id: "m1",
        parentMessageId: null,
        publicId: "msg_1",
        role: "user",
        content: "hi",
        branchReason: null,
        contentBlocks: [],
      },
      {
        id: "m2",
        parentMessageId: "m1",
        publicId: "msg_2",
        role: "assistant",
        content: "hello",
        branchReason: null,
        contentBlocks: [],
      },
    ] as unknown as Array<{ id: string }>;
    dbState.systemCallIdx = 0;
    dbState.tenantSelectIdx = 0;
    dbState.tenantInsertIdx = 0;
    dbState.membershipError = null;
    mockGetSession.mockResolvedValue(SESSION);
  });

  it("denies a non-member (no cross-workspace read)", async () => {
    dbState.wsUserRows = [];
    const res = await loadAgentConversationAction("acme", "main", "pub-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("access");
  });

  it("returns ok:false when the workspace cannot be resolved", async () => {
    dbState.wsRows = [];
    const res = await loadAgentConversationAction("acme", "main", "pub-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("workspace");
  });

  it("returns ok:false when the conversation is not found", async () => {
    dbState.convRows = [];
    const res = await loadAgentConversationAction(
      "acme",
      "main",
      "pub-missing",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not found");
  });

  it("walks the active branch into ordered ChatMessages", async () => {
    const res = await loadAgentConversationAction("acme", "main", "pub-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.conversationId).toBe("conv-1");
      expect(res.activeLeafMessageId).toBe("m2");
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0]).toMatchObject({ role: "user", content: "hi" });
      expect(res.messages[1]).toMatchObject({
        role: "assistant",
        content: "hello",
      });
    }
  });
});

describe("wandResolvePlanAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgRows = [{ id: "org-1" }];
    dbState.wsRows = [{ id: "ws-1" }];
    dbState.wsUserRows = [{ id: "wu-1" }];
    dbState.systemCallIdx = 0;
    dbState.tenantSelectIdx = 0;
    dbState.membershipError = null;
    mockGetSession.mockResolvedValue(SESSION);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false when workspace cannot be resolved", async () => {
    dbState.wsRows = [];
    const res = await wandResolvePlanAction(
      "acme",
      "main",
      "plan-1",
      "approved",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("workspace");
  });

  // Regression: same missing-membership-gate bug as wandResolveApprovalAction,
  // for plan approval/denial/amendment.
  it("denies a non-member — no cross-workspace plan resolution", async () => {
    dbState.wsUserRows = [];
    const res = await wandResolvePlanAction(
      "acme",
      "main",
      "plan-1",
      "approved",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("access");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:true for an approved decision", async () => {
    const res = await wandResolvePlanAction(
      "acme",
      "main",
      "plan-1",
      "approved",
    );
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "approve_plan",
      expect.objectContaining({ planId: "plan-1", decision: "approve" }),
      expect.any(Object),
      { surface: "agent" },
    );
  });

  it("maps 'denied' to 'deny' verb correctly", async () => {
    const res = await wandResolvePlanAction("acme", "main", "plan-1", "denied");
    expect(res.ok).toBe(true);
    const call = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.decision).toBe("deny");
  });

  it("maps 'amended' to 'amend' verb correctly", async () => {
    const res = await wandResolvePlanAction(
      "acme",
      "main",
      "plan-1",
      "amended",
    );
    expect(res.ok).toBe(true);
    const call = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.decision).toBe("amend");
  });
});
