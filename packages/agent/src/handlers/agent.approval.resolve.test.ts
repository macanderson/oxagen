/**
 * Unit tests for the resolve_approval handler (#2906, ARCHITECTURE §3.9 item 15).
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so the refusals below come from the handler alone.
 *
 * Guards and their negatives:
 *   - role gate: org Owner or Admin, or workspace Owner or Member, resolves;
 *     an API-key call acts as the key's creator; a Viewer (org and
 *     workspace), a key with no creator and a user with no principal →
 *     HandlerError forbidden, no UPDATE, no NOTIFY
 *   - id forms: an apr_ public id matches `public_id`; a uuid matches `id`;
 *     the org and workspace filters, the expiry guard and the unresolved
 *     guard stay in the WHERE either way
 *   - no row matched (unknown, expired, already resolved, wrong tenant) →
 *     HandlerError conflict `approval_expired`, no NOTIFY; the same when the
 *     row lapsed between the read and the UPDATE
 *   - through the kernel with a fake usage recorder: a matched decision is
 *     recorded once; the conflict and the forbidden paths record nothing
 *   - mandate hop (ADR-059): a row carrying mandate_id and tool_call_id →
 *     `denied` releases the reservation under the mandate lock and reports
 *     `released`, in the one transaction the UPDATE runs in; `approved`
 *     releases nothing and reports `held`; a row with no mandate reports
 *     null and never touches the ledger
 *   - delivery (ADR-118, #3127): an approved row that stores the parked
 *     call runs it in the deciding request, outside the enclosing governed
 *     action, and answers what the row then records; a delivery that throws
 *     leaves the decision standing and answers the row as it stands; a
 *     denied row and a row with no stored call never run anything
 *   - who answers a mandate row (§6.9, INV-29): a workspace Member who
 *     passes the wide gate but holds no role for moves_money → forbidden,
 *     no lock, no release, no UPDATE; an agent principal (resolved or on an
 *     agent run) → forbidden `agent_cannot_resolve_own_mandate`; an org
 *     Billing user resolves; approvers narrow it: a role outside the list
 *     → `not_an_approver`, a user the list names resolves; a mandate row
 *     gone at the read → `approval_expired`
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@oxagen/database";
import {
  getCapability,
  isHandlerError,
  registerCapability,
} from "@oxagen/oxagen";
import {
  clearBillingAdmissionGate,
  clearHandlersForTests,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  clearUsageRecorder,
  invoke,
  registerHandler,
  setUsageRecorder,
  type GovernedActionRecord,
} from "@oxagen/oxagen/kernel";
import "@oxagen/oxagen/contracts/agent.approval.resolve";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  notifyResolution: vi.fn(async () => undefined),
  lockMandate: vi.fn(async (_tx: unknown, id: string) => ({
    id,
    publicId: "mnd_01k5rt9xq7v3m8n2p4s6t8w0",
  })),
  release: vi.fn(async () => 1),
  resumeApprovedCall: vi.fn<(ref: unknown) => Promise<string>>(
    async () => "succeeded",
  ),
}));

vi.mock("@oxagen/rules", () => ({
  lockMandate: mocks.lockMandate,
  release: mocks.release,
  parseMandateRow: (row: {
    id: string;
    publicId: string;
    consequenceTags: string[];
    approvalRules: { approvers: string[] };
  }) => ({
    id: row.id,
    publicId: row.publicId,
    consequenceTags: row.consequenceTags,
    approval: {
      humanAbove: {},
      alwaysHumanFor: [],
      approvers: row.approvalRules.approvers,
    },
  }),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("../runtime/approval", () => ({
  notifyResolution: mocks.notifyResolution,
}));

vi.mock("../runtime/approval-resume", () => ({
  resumeApprovedCall: mocks.resumeApprovedCall,
}));

import { agentApprovalResolveHandler } from "./agent.approval.resolve";
import { makeCTX } from "../test-utils/fixtures";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

// ── tx double ─────────────────────────────────────────────────────────────────

type Tenant = {
  /** The creator an API key resolves to, or none. */
  keyCreator: string | null;
  principalId: string | null;
  orgRole: string | null;
  workspaceRole: string | null;
  /** The uuid of the pending row the read finds; null for no match. */
  matchedRowId: string | null;
  /** The user whose conversation holds the parked message; null when no message matches. */
  requesterUserId: string | null;
  /** The message the resolved row carries; null when a run parked the call outside any conversation. */
  messageId: string | null;
  /** The mandate hop on the matched row (ADR-059); absent for a chat gate row. */
  mandate?: {
    mandateId: string;
    toolCallId: string;
    /** The mandate's tags; moves_money when absent. */
    tags?: string[];
    approvers?: string[];
    /** False when the mandate row is not found. */
    exists?: boolean;
  };
  /** The workspace's consequence-role overrides. */
  consequenceRoles?: Record<string, string[]>;
  /** The caller's users.public_id. */
  userPublicId?: string;
  /** False when the row lapsed between the read and the UPDATE. */
  updateMatches?: boolean;
  /**
   * A row that stores the parked call (ADR-118): `resume_status` as the
   * UPDATE's CASE leaves it, and the execution the row records when the
   * handler reads it back. Absent for a row with no stored call.
   */
  resume?: {
    afterUpdate: "queued" | "denied";
    readBack: {
      resumeStatus: string | null;
      resumeRunPublicId: string | null;
      resumeError: string | null;
    };
  };
};

type Captured = {
  set: Record<string, unknown> | null;
  where: SQL | null;
  notification: Record<string, unknown> | null;
  /** The WHERE of the requester lookup on `chat.messages`. */
  requesterWhere: SQL | null;
  /** The tx the UPDATE ran on. */
  updateTx: unknown;
  /** Whether `release` had run when the UPDATE started. */
  releasedBeforeUpdate: boolean;
};

/**
 * Answers the role lookups by the table read and the scope the WHERE pinned
 * (an org-wide assignment has `workspace_id is null`; a workspace one carries
 * the id), and the UPDATE by whether the tenant holds a matching row.
 */
function makeTx(tenant: Tenant, captured: Captured) {
  const roleRows = (where: SQL | null): unknown[] => {
    const pinsWorkspace = where
      ? /"workspace_id" = \$/.test(render(where).sql)
      : false;
    const name = pinsWorkspace ? tenant.workspaceRole : tenant.orgRole;
    return name ? [{ roleName: name }] : [];
  };
  const pendingRow = () =>
    tenant.matchedRowId
      ? [
          {
            mandateId: tenant.mandate?.mandateId ?? null,
            toolCallId: tenant.mandate?.toolCallId ?? null,
          },
        ]
      : [];
  const tx = {
    query: {
      workspaces: {
        findFirst: async () => ({
          consequenceRoles: tenant.consequenceRoles ?? {},
        }),
      },
    },
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        let lastWhere: SQL | null = null;
        const chain = {
          innerJoin: () => chain,
          where: (cond: SQL) => {
            lastWhere = cond;
            return chain;
          },
          limit: () => {
            if (table === schema.apiKeys) {
              return Promise.resolve(
                tenant.keyCreator ? [{ createdById: tenant.keyCreator }] : [],
              );
            }
            if (table === schema.principals) {
              return Promise.resolve(
                tenant.principalId ? [{ id: tenant.principalId }] : [],
              );
            }
            if (table === schema.principalRoleAssignments) {
              return Promise.resolve(roleRows(lastWhere));
            }
            if (table === schema.messages) {
              captured.requesterWhere = lastWhere;
              return Promise.resolve(
                tenant.requesterUserId
                  ? [{ userId: tenant.requesterUserId }]
                  : [],
              );
            }
            if (table === schema.approvalRequests) {
              // The execution read-back asks for the resume columns; the
              // pending read asks for the mandate hop.
              if (projection && "resumeRunPublicId" in projection) {
                return Promise.resolve(
                  tenant.resume ? [tenant.resume.readBack] : [],
                );
              }
              return Promise.resolve(pendingRow());
            }
            if (table === schema.mandates) {
              const m = tenant.mandate;
              return Promise.resolve(
                m && m.exists !== false
                  ? [
                      {
                        id: m.mandateId,
                        publicId: "mnd_01k5rt9xq7v3m8n2p4s6t8w0",
                        consequenceTags: m.tags ?? ["moves_money"],
                        approvalRules: { approvers: m.approvers ?? [] },
                      },
                    ]
                  : [],
              );
            }
            if (table === schema.users) {
              return Promise.resolve(
                tenant.userPublicId ? [{ publicId: tenant.userPublicId }] : [],
              );
            }
            throw new Error("unexpected table");
          },
          // The ledger read of the mandate hop: one open reservation.
          then: (resolve: (rows: unknown[]) => unknown) => {
            if (table !== schema.mandateLedger)
              throw new Error("unexpected table");
            return resolve([
              {
                measure: "amount",
                value: "250000000",
                unitOrCurrency: "USD",
                kind: "reserve",
              },
            ]);
          },
        };
        return chain;
      },
    }),
    update: (table: unknown) => {
      if (table !== schema.approvalRequests)
        throw new Error("unexpected table");
      return {
        set: (values: Record<string, unknown>) => {
          captured.set = values;
          captured.updateTx = tx;
          captured.releasedBeforeUpdate = mocks.release.mock.calls.length > 0;
          return {
            where: (cond: SQL) => {
              captured.where = cond;
              return {
                returning: () =>
                  Promise.resolve(
                    tenant.matchedRowId && tenant.updateMatches !== false
                      ? [
                          {
                            id: tenant.matchedRowId,
                            messageId: tenant.messageId,
                            capabilityName: "set_budget",
                            resumeStatus: tenant.resume?.afterUpdate ?? null,
                          },
                        ]
                      : [],
                  ),
              };
            },
          };
        },
      };
    },
    insert: (table: unknown) => {
      if (table !== schema.notifications) throw new Error("unexpected table");
      return {
        values: (values: Record<string, unknown>) => {
          captured.notification = values;
          return Promise.resolve();
        },
      };
    },
  };
  return tx;
}

const MESSAGE_UUID = "7c1e0a2b-3d4f-4a5b-8c6d-9e0f1a2b3c4d";
const ROW_UUID = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";
const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w0";

function setup(overrides: Partial<Tenant> = {}): Captured {
  const tenant: Tenant = {
    keyCreator: "u_creator",
    principalId: "prn_1",
    orgRole: "Owner",
    workspaceRole: null,
    matchedRowId: ROW_UUID,
    requesterUserId: "u_asker",
    messageId: MESSAGE_UUID,
    ...overrides,
  };
  const captured: Captured = {
    set: null,
    where: null,
    notification: null,
    requesterWhere: null,
    updateTx: null,
    releasedBeforeUpdate: false,
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(tenant, captured))),
  );
  return captured;
}

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";
const conflict = (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === "approval_expired";

const CTX = makeCTX({ userId: "u_1" });

beforeEach(() => {
  vi.clearAllMocks();
});

// ── role gate ─────────────────────────────────────────────────────────────────

describe("resolve_approval — role gate", () => {
  it.each(["Owner", "Admin"])("resolves for the org role %s", async (role) => {
    setup({ orgRole: role });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).resolves.toEqual({
      approvalId: PUBLIC_ID,
      resolution: "approved",
      mandate: null,
      execution: null,
    });
  });

  it.each(["Owner", "Member"])(
    "resolves for the workspace role %s when the org role is Viewer",
    async (role) => {
      setup({ orgRole: "Viewer", workspaceRole: role });
      await expect(
        agentApprovalResolveHandler(
          { approvalId: PUBLIC_ID, decision: "denied" },
          CTX,
        ),
      ).resolves.toEqual({
        approvalId: PUBLIC_ID,
        resolution: "denied",
        mandate: null,
        execution: null,
      });
    },
  );

  it("refuses a Viewer on a tier-free org: no row changed, no NOTIFY", async () => {
    const captured = setup({ orgRole: "Viewer", workspaceRole: "Viewer" });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(forbidden);
    expect(captured.set).toBeNull();
    expect(mocks.notifyResolution).not.toHaveBeenCalled();
  });

  it("refuses a user with no principal in the org", async () => {
    const captured = setup({ principalId: null });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(forbidden);
    expect(captured.set).toBeNull();
  });

  it("refuses a call with no user and no API key before any query", async () => {
    const captured = setup();
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        makeCTX({ userId: null, apiKeyId: null }),
      ),
    ).rejects.toSatisfy(forbidden);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
  });

  describe("an API-key call acts as the key's creator", () => {
    const KEY_CTX = makeCTX({ userId: null, apiKeyId: "aky_1" });
    const refused = (reason: string) => (e: unknown) =>
      forbidden(e) && isHandlerError(e) && e.reason === reason;

    it("resolves for a creator who is an org Owner, recorded as the resolver", async () => {
      const captured = setup({ orgRole: "Owner" });
      await expect(
        agentApprovalResolveHandler(
          { approvalId: PUBLIC_ID, decision: "approved" },
          KEY_CTX,
        ),
      ).resolves.toEqual({
        approvalId: PUBLIC_ID,
        resolution: "approved",
        mandate: null,
        execution: null,
      });
      expect(captured.set?.resolvedByUserId).toBe("u_creator");
    });

    it("refuses a key whose creator is a Viewer in the org and the workspace (negative)", async () => {
      const captured = setup({ orgRole: "Viewer", workspaceRole: "Viewer" });
      await expect(
        agentApprovalResolveHandler(
          { approvalId: PUBLIC_ID, decision: "approved" },
          KEY_CTX,
        ),
      ).rejects.toSatisfy(refused("org_role_required"));
      expect(captured.set).toBeNull();
      expect(mocks.notifyResolution).not.toHaveBeenCalled();
    });

    it("refuses a key with no creator (negative)", async () => {
      const captured = setup({ keyCreator: null });
      await expect(
        agentApprovalResolveHandler(
          { approvalId: PUBLIC_ID, decision: "approved" },
          KEY_CTX,
        ),
      ).rejects.toSatisfy(refused("no_principal"));
      expect(captured.set).toBeNull();
    });
  });
});

// ── the UPDATE ────────────────────────────────────────────────────────────────

describe("resolve_approval — the UPDATE", () => {
  it("matches public_id for an apr_ id, inside the org and workspace, unexpired and unresolved", async () => {
    const captured = setup();
    await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved", note: "ok" },
      CTX,
    );
    const q = render(captured.where as SQL);
    expect(q.sql).toMatch(/"public_id" = \$\d/);
    expect(q.sql).not.toMatch(/"approval_requests"\."id" = \$/);
    expect(q.sql).toMatch(/"org_id" = \$\d/);
    expect(q.sql).toMatch(/"workspace_id" = \$\d/);
    expect(q.sql).toMatch(/"expires_at" > now\(\)/);
    expect(q.sql).toMatch(/"resolution" is null/i);
    expect(q.params).toEqual([PUBLIC_ID, CTX.orgId, CTX.workspaceId]);
    const queued = render(captured.set?.resumeStatus as SQL);
    expect(queued.sql).toMatch(/"resume_payload" IS NOT NULL/i);
    expect(queued.params).toContain("queued");
    expect(captured.set).toMatchObject({
      resolution: "approved",
      resolvedByUserId: "u_1",
      note: "ok",
    });
  });

  it("matches the row uuid for a uuid, with the same scope and guards", async () => {
    const captured = setup();
    await agentApprovalResolveHandler(
      { approvalId: ROW_UUID, decision: "denied" },
      CTX,
    );
    const q = render(captured.where as SQL);
    expect(q.sql).toMatch(/"approval_requests"\."id" = \$\d/);
    expect(q.sql).not.toMatch(/public_id/);
    expect(q.params).toEqual([ROW_UUID, CTX.orgId, CTX.workspaceId]);
    expect(captured.set).toMatchObject({ resolution: "denied", note: null });
  });

  it("notifies the waiter by the row uuid and echoes the caller's id form", async () => {
    setup();
    const res = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(mocks.notifyResolution).toHaveBeenCalledWith({
      approvalId: ROW_UUID,
      resolution: "approved",
      note: null,
    });
    expect(res).toEqual({
      approvalId: PUBLIC_ID,
      resolution: "approved",
      mandate: null,
      execution: null,
    });
  });

  it("tells the person whose message parked the call, with the decision and the note", async () => {
    const captured = setup();
    await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "denied", note: "over budget" },
      CTX,
    );
    expect(captured.notification).toEqual({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      userId: "u_asker",
      kind: "approval",
      event: "approval.resolved",
      title: "Approval denied: set_budget",
      body: "over budget",
      deepLink: null,
    });
    // The asker is found through the message the approval row carries, which
    // the in-app agent's turn sets to the persisted user message's id
    // (assistant-turn.test.ts pins that side), inside the caller's tenant.
    const lookup = render(captured.requesterWhere!);
    expect(lookup.sql).toMatch(/"messages"\."id" = \$/);
    expect(lookup.sql).toMatch(/"messages"\."org_id" = \$/);
    expect(lookup.sql).toMatch(/"messages"\."workspace_id" = \$/);
    expect(lookup.params).toContain(MESSAGE_UUID);
  });

  it.each([
    ["the resolver is the person who asked", { requesterUserId: "u_1" }],
    ["no chat message backs the approval", { requesterUserId: null }],
    ["the row carries no message id", { messageId: null }],
    ["no row matched", { matchedRowId: null }],
  ])(
    "writes no approval.resolved row when %s (negative)",
    async (_why, overrides) => {
      const captured = setup(overrides);
      await agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ).catch(() => undefined);
      expect(captured.notification).toBeNull();
    },
  );

  it("runs no requester lookup at all when the row carries no message id", async () => {
    const captured = setup({ messageId: null });
    await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(captured.requesterWhere).toBeNull();
    expect(captured.notification).toBeNull();
  });

  it("throws conflict approval_expired when no row matched, and notifies nobody", async () => {
    const captured = setup({ matchedRowId: null });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(conflict);
    expect(captured.set).toBeNull();
    expect(mocks.notifyResolution).not.toHaveBeenCalled();
  });

  it("throws conflict approval_expired when the row lapsed between the read and the UPDATE", async () => {
    const captured = setup({ updateMatches: false });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(conflict);
    expect(captured.set).toMatchObject({ resolution: "approved" });
    expect(mocks.notifyResolution).not.toHaveBeenCalled();
  });
});

// ── through the kernel: what is billed ────────────────────────────────────────

describe("resolve_approval — governed-action accrual through the kernel", () => {
  const ORG = "00000000-0000-0000-0000-000000000001";
  const WS = "00000000-0000-0000-0000-000000000002";
  const USER = "00000000-0000-0000-0000-000000000003";
  const kernelCtx = makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });

  let recorder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearBillingAdmissionGate();
    clearSecurityEventEmitter();
    // The kernel has validated the input against the contract by the time
    // the handler runs; the loader narrows `unknown` the way register.ts does.
    registerHandler(
      "resolve_approval",
      async () => (input, ctx) =>
        agentApprovalResolveHandler(
          input as Parameters<typeof agentApprovalResolveHandler>[0],
          ctx,
        ),
    );
    recorder = vi.fn();
    setUsageRecorder(
      recorder as unknown as (r: GovernedActionRecord) => Promise<void>,
    );
  });

  afterEach(() => {
    clearUsageRecorder();
    clearHandlersForTests();
  });

  it("records one governed action for a decision that matched a row", async () => {
    setup();
    const out = await invoke(
      "resolve_approval",
      { approvalId: PUBLIC_ID, decision: "approved" },
      kernelCtx,
    );
    expect(out).toEqual({
      approvalId: PUBLIC_ID,
      resolution: "approved",
      mandate: null,
      execution: null,
    });
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder.mock.calls[0]?.[0]).toMatchObject({
      capability: "resolve_approval",
      orgId: ORG,
      actions: 1,
    });
  });

  it("records nothing for an id that matched no row: the conflict leaves before the recorder", async () => {
    setup({ matchedRowId: null });
    await expect(
      invoke(
        "resolve_approval",
        { approvalId: PUBLIC_ID, decision: "approved" },
        kernelCtx,
      ),
    ).rejects.toSatisfy(conflict);
    expect(recorder).not.toHaveBeenCalled();
    expect(mocks.notifyResolution).not.toHaveBeenCalled();
  });

  it("records nothing for a Viewer: the forbidden leaves before the UPDATE", async () => {
    const captured = setup({ orgRole: "Viewer", workspaceRole: "Viewer" });
    await expect(
      invoke(
        "resolve_approval",
        { approvalId: ROW_UUID, decision: "approved" },
        kernelCtx,
      ),
    ).rejects.toSatisfy(forbidden);
    expect(recorder).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
  });

  it("refuses an id that is neither apr_ nor a uuid at the contract, before the handler", async () => {
    const captured = setup();
    await expect(
      invoke(
        "resolve_approval",
        { approvalId: "appr-1", decision: "approved" },
        kernelCtx,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
    expect(recorder).not.toHaveBeenCalled();
  });
});

// ── delivering the approved call (ADR-118, #3127) ────────────────────────────

describe("resolve_approval — delivering the approved call", () => {
  const RAN = {
    resumeStatus: "succeeded",
    resumeRunPublicId: "arun_resumed",
    resumeError: null,
  };

  it("runs an approved stored call in the deciding request and answers what the row records", async () => {
    setup({ resume: { afterUpdate: "queued", readBack: RAN } });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    // Delivered by the row uuid, inside the caller's org and workspace.
    expect(mocks.resumeApprovedCall).toHaveBeenCalledTimes(1);
    expect(mocks.resumeApprovedCall).toHaveBeenCalledWith({
      id: ROW_UUID,
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    // The answer is the row read back, not what the delivery returned.
    expect(out.execution).toEqual({
      status: "succeeded",
      runId: "arun_resumed",
      reason: null,
    });
  });

  it("reports a refused delivery as the row records it", async () => {
    mocks.resumeApprovedCall.mockResolvedValueOnce("failed");
    setup({
      resume: {
        afterUpdate: "queued",
        readBack: {
          resumeStatus: "failed",
          resumeRunPublicId: null,
          resumeError: "requester_access_revoked",
        },
      },
    });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(out.execution).toEqual({
      status: "failed",
      runId: null,
      reason: "requester_access_revoked",
    });
  });

  it("keeps the decision when delivery throws, and answers the row as it stands (negative)", async () => {
    mocks.resumeApprovedCall.mockRejectedValueOnce(new Error("ledger down"));
    const captured = setup({
      resume: {
        afterUpdate: "queued",
        readBack: {
          resumeStatus: "queued",
          resumeRunPublicId: null,
          resumeError: null,
        },
      },
    });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(captured.set).toMatchObject({ resolution: "approved" });
    expect(mocks.notifyResolution).toHaveBeenCalledTimes(1);
    expect(out.resolution).toBe("approved");
    // Still queued, so the periodic worker delivers it.
    expect(out.execution).toEqual({
      status: "queued",
      runId: null,
      reason: null,
    });
  });

  it("never runs a denied stored call (negative)", async () => {
    setup({
      resume: {
        afterUpdate: "denied",
        readBack: {
          resumeStatus: "denied",
          resumeRunPublicId: null,
          resumeError: null,
        },
      },
    });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "denied", note: "not now" },
      CTX,
    );
    expect(mocks.resumeApprovedCall).not.toHaveBeenCalled();
    expect(out.execution).toEqual({
      status: "denied",
      runId: null,
      reason: null,
    });
  });

  it("runs nothing and answers no execution for a row that stores no call (negative)", async () => {
    setup();
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(mocks.resumeApprovedCall).not.toHaveBeenCalled();
    expect(out.execution).toBeNull();
  });

  describe("through the kernel", () => {
    const ORG = "00000000-0000-0000-0000-000000000001";
    const WS = "00000000-0000-0000-0000-000000000002";
    const USER = "00000000-0000-0000-0000-000000000003";
    const kernelCtx = makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });
    const PARKED = "test.parked_write";
    let recorder: Mock<(r: GovernedActionRecord) => Promise<void>>;

    beforeEach(() => {
      clearHandlersForTests();
      clearKernelIAMRuntime();
      clearBillingAdmissionGate();
      clearSecurityEventEmitter();
      if (!getCapability(PARKED)) {
        registerCapability({
          name: PARKED,
          domain: "test",
          description: "The write a parked call asked for.",
          mode: "sync" as const,
          surfaces: ["agent"] as const,
          layers: ["unit"] as const,
          sensitivity: "low" as const,
          defaultEffect: "allow" as const,
          defaultRoles: { org: {}, workspace: {} },
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
        });
      }
      registerHandler(
        "resolve_approval",
        async () => (input, ctx) =>
          agentApprovalResolveHandler(
            input as Parameters<typeof agentApprovalResolveHandler>[0],
            ctx,
          ),
      );
      registerHandler(PARKED, async () => async () => ({ ok: true }));
      recorder = vi.fn<(r: GovernedActionRecord) => Promise<void>>();
      setUsageRecorder(recorder);
      // The delivery invokes the stored call the way resumeApprovedCall does.
      mocks.resumeApprovedCall.mockImplementationOnce(async () => {
        await invoke(PARKED, {}, kernelCtx, { surface: "agent" });
        return "succeeded";
      });
    });

    afterEach(() => {
      clearUsageRecorder();
      clearHandlersForTests();
    });

    it("meters the delivered call as its own governed action, not as part of the decision", async () => {
      setup({ resume: { afterUpdate: "queued", readBack: RAN } });
      await invoke(
        "resolve_approval",
        { approvalId: PUBLIC_ID, decision: "approved" },
        kernelCtx,
      );
      // Nested inside the decision, the call would accrue nothing, and the
      // write would go unmetered where the periodic worker meters it.
      const billed = recorder.mock.calls.map(([record]) => record.capability);
      expect(billed).toEqual([PARKED, "resolve_approval"]);
    });
  });
});

// ── the mandate hop ──────────────────────────────────────────────────────────

describe("resolve_approval — the mandate hop", () => {
  const MANDATE_ID = "6f0c2a4e-1b3d-4c5e-8a7f-9d1e3b5c7a2f";
  const TOOL_CALL_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("denied: releases the reservation under the mandate lock, in the UPDATE's transaction, and reports released", async () => {
    const captured = setup({
      mandate: { mandateId: MANDATE_ID, toolCallId: TOOL_CALL_ID },
    });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "denied" },
      CTX,
    );
    // The lock, the release and the UPDATE share one transaction.
    expect(captured.updateTx).not.toBeNull();
    expect(mocks.lockMandate).toHaveBeenCalledWith(
      captured.updateTx,
      MANDATE_ID,
    );
    expect(mocks.release).toHaveBeenCalledWith(captured.updateTx, {
      mandate: expect.objectContaining({ id: MANDATE_ID }),
      toolCallId: TOOL_CALL_ID,
    });
    // The mandate row lock and the release precede the resolution write.
    expect(captured.releasedBeforeUpdate).toBe(true);
    expect(out.mandate).toEqual({
      mandateId: "mnd_01k5rt9xq7v3m8n2p4s6t8w0",
      reserved: [
        { measure: "amount", value: "250000000", unitOrCurrency: "USD" },
      ],
      outcome: "released",
    });
  });

  it("approved: leaves the reservation held for the retry and reports held", async () => {
    setup({ mandate: { mandateId: MANDATE_ID, toolCallId: TOOL_CALL_ID } });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(mocks.release).not.toHaveBeenCalled();
    expect(out.mandate?.outcome).toBe("held");
    expect(out.mandate?.reserved).toHaveLength(1);
  });

  it("a row with no mandate never touches the ledger", async () => {
    setup();
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "denied" },
      CTX,
    );
    expect(mocks.lockMandate).not.toHaveBeenCalled();
    expect(out.mandate).toBeNull();
  });
});

// ── who answers a mandate row ────────────────────────────────────────────────

describe("resolve_approval — who answers a call a mandate parked", () => {
  const MANDATE_ID = "6f0c2a4e-1b3d-4c5e-8a7f-9d1e3b5c7a2f";
  const TOOL_CALL_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const hop = { mandateId: MANDATE_ID, toolCallId: TOOL_CALL_ID };
  const refused = (reason: string) => (e: unknown) =>
    isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

  const untouched = (captured: Captured) => {
    expect(mocks.lockMandate).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
    expect(mocks.notifyResolution).not.toHaveBeenCalled();
  };

  it("refuses a workspace Member on a moves_money mandate: no lock, no ledger row, no UPDATE", async () => {
    const captured = setup({
      orgRole: "Viewer",
      workspaceRole: "Member",
      mandate: hop,
    });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(refused("org_role_required"));
    untouched(captured);
  });

  it.each([
    [
      "a resolved agent principal",
      {
        principal: {
          id: "prn_agent",
          kind: "agent" as const,
          orgId: CTX.orgId,
          workspaceId: CTX.workspaceId,
        },
      },
    ],
    ["an agent run", { agentRun: { principalKind: "agent" } as never }],
  ])("refuses %s", async (_label, extra) => {
    const captured = setup({ mandate: hop });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        { ...CTX, ...extra },
      ),
    ).rejects.toSatisfy(refused("agent_cannot_resolve_own_mandate"));
    untouched(captured);
  });

  it("lets an org Billing user who is a workspace Member deny, releasing the reservation", async () => {
    setup({ orgRole: "Billing", workspaceRole: "Member", mandate: hop });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "denied" },
      CTX,
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(out.mandate?.outcome).toBe("released");
  });

  it("follows the workspace's consequence-role override", async () => {
    const captured = setup({
      orgRole: "Owner",
      mandate: hop,
      consequenceRoles: { moves_money: ["Billing"] },
    });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(refused("org_role_required"));
    untouched(captured);
  });

  it("refuses a caller outside the mandate's approvers", async () => {
    const captured = setup({
      orgRole: "Owner",
      mandate: { ...hop, approvers: ["role:Billing"] },
    });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(refused("not_an_approver"));
    untouched(captured);
  });

  it("lets a user the approvers name resolve", async () => {
    setup({
      orgRole: "Owner",
      userPublicId: "usr_01owner",
      mandate: { ...hop, approvers: ["user:usr_01owner"] },
    });
    const out = await agentApprovalResolveHandler(
      { approvalId: PUBLIC_ID, decision: "approved" },
      CTX,
    );
    expect(out.mandate?.outcome).toBe("held");
  });

  it("reads a row whose mandate is gone as not pending", async () => {
    const captured = setup({ mandate: { ...hop, exists: false } });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(conflict);
    untouched(captured);
  });
});
