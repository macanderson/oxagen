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
  };

  const mockRunInTenantScope = vi.fn(
    (_scope: unknown, fn: () => unknown) => fn(),
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
            if (dbState.systemCallIdx % 2 === 1) return Promise.resolve(dbState.orgRows);
            return Promise.resolve(dbState.wsRows);
          },
        }),
      }),
    }),
  });

  const makeTenantTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => {
            // First tenant SELECT in wandSendAction is the workspace-membership
            // check; subsequent ones are the conversation lookup.
            dbState.tenantSelectIdx++;
            if (dbState.tenantSelectIdx === 1) return Promise.resolve(dbState.wsUserRows);
            return Promise.resolve(dbState.convRows);
          },
        }),
      }),
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
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeSystemTx>) => unknown) => {
      // Do NOT reset systemCallIdx here — the helper makes two separate
      // withSystemDb calls (org then ws) and the counter must survive both.
      return fn(makeSystemTx());
    }),
    withTenantDb: vi.fn(
      (fn: (tx: ReturnType<typeof makeTenantTx>) => unknown) => fn(makeTenantTx()),
    ),
    schema: {
      organizations: { id: "org_id", slug: "org_slug" },
      workspaces: { id: "ws_id", orgId: "ws_orgId", slug: "ws_slug" },
      workspaceUsers: { id: "wu_id", workspaceId: "wu_wsId", userId: "wu_userId" },
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
        if (!r?.content) return { success: false, error: { issues: [{ message: "Invalid" }] } };
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
          return { success: false, error: { issues: [{ message: "Invalid" }] } };
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
          return { success: false, error: { issues: [{ message: "Invalid" }] } };
        return { success: true, data: r };
      },
    },
  },
}));

import {
  wandSendAction,
  wandResolveApprovalAction,
  wandResolvePlanAction,
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
    mockGetSession.mockResolvedValue(SESSION);
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
    dbState.systemCallIdx = 0;
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

  it("returns ok:true and calls invoke for a valid approval", async () => {
    const res = await wandResolveApprovalAction(
      "acme",
      "main",
      "appr-1",
      "approved",
    );
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.approval.resolve",
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
// Tests — wandResolvePlanAction
// ---------------------------------------------------------------------------

describe("wandResolvePlanAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.orgRows = [{ id: "org-1" }];
    dbState.wsRows = [{ id: "ws-1" }];
    dbState.systemCallIdx = 0;
    mockGetSession.mockResolvedValue(SESSION);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns ok:false when workspace cannot be resolved", async () => {
    dbState.wsRows = [];
    const res = await wandResolvePlanAction("acme", "main", "plan-1", "approved");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("workspace");
  });

  it("returns ok:true for an approved decision", async () => {
    const res = await wandResolvePlanAction("acme", "main", "plan-1", "approved");
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.plan.approve",
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
    const res = await wandResolvePlanAction("acme", "main", "plan-1", "amended");
    expect(res.ok).toBe(true);
    const call = mockInvoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.decision).toBe("amend");
  });
});
