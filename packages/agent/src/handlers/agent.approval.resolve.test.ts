/**
 * Unit tests for the resolve_approval handler (#2906, ARCHITECTURE §3.9 item 15).
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so the refusals below come from the handler alone.
 *
 * Guards and their negatives:
 *   - role gate: org Owner or Admin, or workspace Owner or Member, resolves;
 *     a Viewer (org and workspace), an API-key call and a user with no
 *     principal → HandlerError forbidden, no UPDATE, no NOTIFY
 *   - id forms: an apr_ public id matches `public_id`; a uuid matches `id`;
 *     the org and workspace filters, the expiry guard and the unresolved
 *     guard stay in the WHERE either way
 *   - no row matched (unknown, expired, already resolved, wrong tenant) →
 *     HandlerError conflict `approval_expired`, no NOTIFY
 *   - through the kernel with a fake usage recorder: a matched decision is
 *     recorded once; the conflict and the forbidden paths record nothing
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
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("../runtime/approval", () => ({
  notifyResolution: mocks.notifyResolution,
}));

import { agentApprovalResolveHandler } from "./agent.approval.resolve";
import { makeCTX } from "../test-utils/fixtures";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

// ── tx double ─────────────────────────────────────────────────────────────────

type Tenant = {
  principalId: string | null;
  orgRole: string | null;
  workspaceRole: string | null;
  /** The uuid RETURNING yields when the UPDATE matched a row; null for no match. */
  matchedRowId: string | null;
};

type Captured = { set: Record<string, unknown> | null; where: SQL | null };

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
  return {
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
            if (table === schema.principals) {
              return Promise.resolve(
                tenant.principalId ? [{ id: tenant.principalId }] : [],
              );
            }
            if (table === schema.principalRoleAssignments) {
              return Promise.resolve(roleRows(lastWhere));
            }
            throw new Error("unexpected table");
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
          return {
            where: (cond: SQL) => {
              captured.where = cond;
              return {
                returning: () =>
                  Promise.resolve(
                    tenant.matchedRowId ? [{ id: tenant.matchedRowId }] : [],
                  ),
              };
            },
          };
        },
      };
    },
  };
}

const ROW_UUID = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";
const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w0";

function setup(overrides: Partial<Tenant> = {}): Captured {
  const tenant: Tenant = {
    principalId: "prn_1",
    orgRole: "Owner",
    workspaceRole: null,
    matchedRowId: ROW_UUID,
    ...overrides,
  };
  const captured: Captured = { set: null, where: null };
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
    ).resolves.toEqual({ approvalId: PUBLIC_ID, resolution: "approved" });
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
      ).resolves.toEqual({ approvalId: PUBLIC_ID, resolution: "denied" });
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

  it("refuses an API-key call before any query", async () => {
    const captured = setup();
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        makeCTX({ userId: null, apiKeyId: "aky_1" }),
      ),
    ).rejects.toSatisfy(forbidden);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(captured.set).toBeNull();
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
    expect(res).toEqual({ approvalId: PUBLIC_ID, resolution: "approved" });
  });

  it("throws conflict approval_expired when no row matched, and notifies nobody", async () => {
    setup({ matchedRowId: null });
    await expect(
      agentApprovalResolveHandler(
        { approvalId: PUBLIC_ID, decision: "approved" },
        CTX,
      ),
    ).rejects.toSatisfy(conflict);
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
    expect(out).toEqual({ approvalId: PUBLIC_ID, resolution: "approved" });
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
