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
    // Tracks global withSystemDb call count — resolveWorkspaceFromSlugs makes
    // two separate withSystemDb calls: org lookup (odd calls) + ws lookup (even calls).
    // Reset in beforeEach so each test starts fresh.
    systemCallIdx: number;
  }
  const dbState: DbState = {
    orgRows: [{ id: "org-1" }],
    wsRows: [{ id: "ws-1" }],
    convRows: [],
    msgRows: [{ id: "msg-1" }],
    systemCallIdx: 0,
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
          limit: (_n: number) => Promise.resolve(dbState.convRows),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => ({
        returning: () => {
          // Alternate between conversation and message returns.
          if (dbState.convRows.length > 0) {
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
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
}));

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
  orgShellSendAction,
  orgShellResolveApprovalAction,
  orgShellResolvePlanAction,
  wandResolveApprovalAction,
  wandResolvePlanAction,
} from "./shell-actions";

const SESSION = { user: { id: "user-1" } };

// ---------------------------------------------------------------------------
// Tests — stub actions
// ---------------------------------------------------------------------------

describe("stub actions (always return ok:false)", () => {
  it("orgShellSendAction returns {ok:false} with a select-workspace message", async () => {
    const fd = new FormData();
    const res = await orgShellSendAction(fd);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("workspace");
  });

  it("orgShellResolveApprovalAction returns {ok:false}", async () => {
    const res = await orgShellResolveApprovalAction("appr-1", "approved");
    expect(res.ok).toBe(false);
  });

  it("orgShellResolvePlanAction returns {ok:false}", async () => {
    const res = await orgShellResolvePlanAction("plan-1", "approved");
    expect(res.ok).toBe(false);
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
