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
 *   - who answers a mandate row (§6.9, INV-29): a workspace Member who
 *     passes the wide gate but holds no role for moves_money → forbidden,
 *     no lock, no release, no UPDATE; an agent principal (resolved or on an
 *     agent run) → forbidden `agent_cannot_resolve_own_mandate`; an org
 *     Billing user resolves; approvers narrow it: a role outside the list
 *     → `not_an_approver`, a user the list names resolves; a mandate row
 *     gone at the read → `approval_expired`
 *   - a run and the approval it raised (R1, ADR-XXX): a call whose run is the
 *     one the row records, by its internal id or its public id → forbidden
 *     `run_cannot_resolve_own_approval`, no UPDATE, no NOTIFY, nothing
 *     recorded through the kernel; a call with no run, a call from another
 *     run, and a row that records no run resolve, and the last two make no
 *     run lookup the answer does not need
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { schema } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";
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

// resolveRunPublicId stays real: the self-approval check reads the calling
// run's public id through it, against the tx double below.
vi.mock("../runtime/approval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/approval")>()),
  notifyResolution: mocks.notifyResolution,
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
  /** The run the row records as having parked the call; null when none. */
  runPublicId?: string | null;
  /** `agent_runs` in this workspace: internal id → public id. */
  runs?: Record<string, string>;
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
  /** How many times the `agent_runs` lookup ran. */
  runLookups: number;
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
            runPublicId: tenant.runPublicId ?? null,
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
    select: () => ({
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
            if (table === schema.agentRuns) {
              captured.runLookups += 1;
              const ids = lastWhere ? render(lastWhere).params : [];
              const hit = Object.entries(tenant.runs ?? {}).find(([id]) =>
                ids.includes(id),
              );
              return Promise.resolve(hit ? [{ publicId: hit[1] }] : []);
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
/** A run that parked a call: `agent_runs.id` and its public id. */
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const RUN_PUBLIC_ID = "arun_01k5rt9xq7v3m8n2p4s6t8w0";
const OTHER_RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const RUNS = {
  [RUN_UUID]: RUN_PUBLIC_ID,
  [OTHER_RUN_UUID]: "arun_01k5rt9xq7v3m8n2p4s6t8w9",
};

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
    runLookups: 0,
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(tenant, captured))),
  );
  return captured;
}

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";
const ownRun = (e: unknown) =>
  forbidden(e) &&
  isHandlerError(e) &&
  e.reason === "run_cannot_resolve_own_approval";
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

  it("records nothing for a call from the run that raised the approval: opts.runId reaches the handler", async () => {
    const captured = setup({ runPublicId: RUN_PUBLIC_ID, runs: RUNS });
    await expect(
      invoke(
        "resolve_approval",
        { approvalId: PUBLIC_ID, decision: "approved" },
        kernelCtx,
        { runId: RUN_UUID },
      ),
    ).rejects.toSatisfy(ownRun);
    expect(recorder).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
  });

  it("refuses the agent surface before the handler: a model is never offered the decision", async () => {
    const captured = setup();
    await expect(
      invoke(
        "resolve_approval",
        { approvalId: PUBLIC_ID, decision: "approved" },
        kernelCtx,
        { surface: "agent" },
      ),
    ).rejects.toMatchObject({ code: "surface_denied" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
    expect(recorder).not.toHaveBeenCalled();
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

// ── a run and the approval it raised ─────────────────────────────────────────

describe("resolve_approval — a run and the approval it raised (R1)", () => {
  it.each([
    ["its internal id, as the in-app assistant carries it", RUN_UUID],
    ["its public id", RUN_PUBLIC_ID],
  ])(
    "refuses a call from the run that raised it, by %s: no UPDATE, no NOTIFY",
    async (_how, runId) => {
      const captured = setup({ runPublicId: RUN_PUBLIC_ID, runs: RUNS });
      const err = await agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        { ...CTX, runId },
      ).catch((e: unknown) => e);
      expect(err).toSatisfy(ownRun);
      // The refusal sends the person to the page where they decide.
      expect((err as Error).message).toBe(
        "The run that raised this approval cannot resolve it. Approve or deny it on Fleet.",
      );
      expect(captured.set).toBeNull();
      expect(captured.notification).toBeNull();
      expect(mocks.notifyResolution).not.toHaveBeenCalled();
    },
  );

  it("lets the person resolve the same approval with no run on the call, as Fleet does", async () => {
    const captured = setup({ runPublicId: RUN_PUBLIC_ID, runs: RUNS });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).resolves.toEqual({
      approvalId: PUBLIC_ID,
      resolution: "approved",
      mandate: null,
    });
    expect(captured.set).toMatchObject({
      resolution: "approved",
      resolvedByUserId: "u_1",
    });
    // No run on the call leaves nothing to compare, so no run is read.
    expect(captured.runLookups).toBe(0);
  });

  it("does not refuse a call from a run the row does not record (negative)", async () => {
    const captured = setup({ runPublicId: RUN_PUBLIC_ID, runs: RUNS });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "denied" },
        { ...CTX, runId: OTHER_RUN_UUID },
      ),
    ).resolves.toMatchObject({ resolution: "denied" });
    expect(captured.runLookups).toBe(1);
  });

  it("does not refuse a uuid that names no run in this workspace (negative)", async () => {
    const captured = setup({ runPublicId: RUN_PUBLIC_ID, runs: {} });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        { ...CTX, runId: RUN_UUID },
      ),
    ).resolves.toMatchObject({ resolution: "approved" });
    expect(captured.runLookups).toBe(1);
  });

  it("does not refuse when the row records no run, and reads no run (negative)", async () => {
    const captured = setup({ runPublicId: null, runs: RUNS });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        { ...CTX, runId: RUN_UUID },
      ),
    ).resolves.toMatchObject({ resolution: "approved" });
    expect(captured.runLookups).toBe(0);
  });
});
