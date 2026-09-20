/**
 * mandate/expiry (ADR-059 decision 7).
 *
 * Guards and their negatives:
 *   - nothing due and nothing lapsed → no tenant scope entered, no event
 *   - a due mandate: the lock is taken in its own tenant scope, parked
 *     reservations are released, its unresolved approval rows expire, the
 *     status flips to expired and one mandate.expired event is emitted
 *   - a mandate revoked between the scan and the lock is skipped: no
 *     release, no update, no event
 *   - a failure on one mandate is logged and the next still expires
 *   - a lapsed approval: voided under its mandate's lock in the mandate's
 *     tenant scope; a mandate row gone by the lock is skipped; a failure
 *     on one row is logged and the next is still voided
 *   - the scans select exactly: active mandates past valid_to; approvals a
 *     mandate parked, never used, past expires_at, and unresolved or
 *     approved (a used, denied, expired or unexpired row is not selected);
 *     the approval UPDATE touches only the mandate's unresolved rows
 * The ledger arithmetic of a void is the rules package's; see
 * packages/rules/src/mandates.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  emitSecurityEventAsync: vi.fn(async () => undefined),
  lockMandate: vi.fn(),
  releaseParked: vi.fn(async () => 2),
  expireApproval: vi.fn(async () => 1),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));
vi.mock("@oxagen/database", () => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
    schema: {
      mandates: {
        id: "id",
        publicId: "public_id",
        orgId: "org_id",
        workspaceId: "workspace_id",
        status: "status",
        validTo: "valid_to",
      },
      approvalRequests: {
        id: "id",
        mandateId: "mandate_id",
        toolCallId: "tool_call_id",
        orgId: "org_id",
        workspaceId: "workspace_id",
        tokenUsedAt: "token_used_at",
        expiresAt: "expires_at",
        resolution: "resolution",
      },
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));
vi.mock("@oxagen/rules", () => ({
  lockMandate: mocks.lockMandate,
  releaseParked: mocks.releaseParked,
  expireApproval: mocks.expireApproval,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
// Each operator returns a tagged tuple, so a test can assert the predicate
// the job built: `and(isNull(x))` is ["and", ["isNull", "x"]].
vi.mock("drizzle-orm", () => {
  const op =
    (name: string) =>
    (...a: unknown[]) => [name, ...a];
  return {
    and: op("and"),
    or: op("or"),
    eq: op("eq"),
    isNull: op("isNull"),
    isNotNull: op("isNotNull"),
    lt: op("lt"),
    sql: (_parts: TemplateStringsArray, ...values: unknown[]) => values,
  };
});
vi.mock("../logger", () => ({ logger: mocks.logger }));

type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};
type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;
let capturedHandler: HandlerFn | null = null;
mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);
await import("./mandate.expiry");

const step: StepCtx = { run: async (_n, fn) => fn() };

type Due = { id: string; publicId: string; orgId: string; workspaceId: string };
type Lapsed = {
  id: string;
  mandateId: string | null;
  toolCallId: string | null;
  orgId: string;
  workspaceId: string;
};

/** The two cross-tenant scans, in the order the job runs them; returns each scan's WHERE spy. */
function scans(due: Due[], lapsed: Lapsed[] = []) {
  return [due, lapsed].map((rows) => {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn({ select: () => ({ from }) }),
    );
    return where;
  });
}

/** A tenant tx whose updates record their SET values and WHERE predicates. */
function makeTenantTx(updated: { id: string }[] = [{ id: "apr-1" }]) {
  const sets: Record<string, unknown>[] = [];
  const wheres: unknown[] = [];
  const tx = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return {
          where: (w: unknown) => {
            wheres.push(w);
            return Object.assign(Promise.resolve(), {
              returning: async () => updated,
            });
          },
        };
      },
    }),
  };
  return { tx, sets, wheres };
}

const A: Due = {
  id: "m-a",
  publicId: "mnd_a",
  orgId: "org-1",
  workspaceId: "ws-1",
};
const B: Due = {
  id: "m-b",
  publicId: "mnd_b",
  orgId: "org-2",
  workspaceId: "ws-2",
};
const L1: Lapsed = {
  id: "apr-1",
  mandateId: "m-c",
  toolCallId: "call-1",
  orgId: "org-3",
  workspaceId: "ws-3",
};
const L2: Lapsed = {
  id: "apr-2",
  mandateId: "m-d",
  toolCallId: "call-2",
  orgId: "org-4",
  workspaceId: "ws-4",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runInTenantScope.mockImplementation(
    async (_scope: unknown, fn: () => unknown) => fn(),
  );
  mocks.withTenantDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn(makeTenantTx().tx),
  );
});

describe("mandate/expiry", () => {
  it("scans for active mandates past valid_to, and for parked approvals never used, past expires_at, unresolved or approved", async () => {
    const [dueWhere, lapsedWhere] = scans([]);
    await capturedHandler!({ step });
    expect(dueWhere).toHaveBeenCalledWith([
      "and",
      ["eq", "status", "active"],
      ["lt", "valid_to", expect.any(Date)],
    ]);
    expect(lapsedWhere).toHaveBeenCalledWith([
      "and",
      ["isNull", "token_used_at"],
      ["lt", "expires_at", expect.any(Date)],
      [
        "or",
        ["isNull", "resolution"],
        ["and", ["isNotNull", "mandate_id"], ["eq", "resolution", "approved"]],
      ],
    ]);
  });

  it("does nothing when no mandate is past its validity window and no approval lapsed", async () => {
    scans([]);
    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 0,
    });
    expect(mocks.runInTenantScope).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("expires a due mandate in its own tenant scope under the lock, releasing parked calls and emitting one event", async () => {
    scans([A]);
    const { tx, sets, wheres } = makeTenantTx();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    const locked = { id: A.id, status: "active" };
    mocks.lockMandate.mockResolvedValueOnce(locked);

    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 1,
      voided: 0,
    });

    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      expect.any(Function),
    );
    expect(mocks.lockMandate).toHaveBeenCalledWith(tx, A.id);
    expect(mocks.releaseParked).toHaveBeenCalledWith(tx, locked);
    expect(sets[0]).toMatchObject({ resolution: "expired" });
    expect(wheres[0]).toEqual([
      "and",
      ["eq", "mandate_id", A.id],
      ["isNull", "resolution"],
    ]);
    expect(sets[1]).toMatchObject({ status: "expired" });
    expect(wheres[1]).toEqual(["eq", "id", A.id]);
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "mandate.expired",
        orgId: "org-1",
        workspaceId: "ws-1",
        requestId: "mandate-expiry:m-a",
      }),
    );
  });

  it("skips a mandate that was revoked between the scan and the lock", async () => {
    scans([A]);
    const { tx, sets } = makeTenantTx();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    mocks.lockMandate.mockResolvedValueOnce({ id: A.id, status: "revoked" });

    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 0,
    });
    expect(mocks.releaseParked).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("logs a failing mandate and still expires the next", async () => {
    scans([A, B]);
    mocks.withTenantDb
      .mockImplementationOnce(async () => {
        throw new Error("lock timeout");
      })
      .mockImplementationOnce(async (fn: (t: unknown) => unknown) =>
        fn(makeTenantTx().tx),
      );
    mocks.lockMandate.mockResolvedValueOnce({ id: B.id, status: "active" });

    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 1,
      voided: 0,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mandateId: "mnd_a" }),
      "mandate.expiry: failed for mandate (retried next run)",
    );
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-2" }),
    );
  });

  it("persists an ordinary timeout with its expiry instant and protects concurrent decisions", async () => {
    scans([], [{ ...L1, mandateId: null }]);
    const { tx, sets, wheres } = makeTenantTx();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 1,
    });
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: L1.orgId, workspaceId: L1.workspaceId },
      expect.any(Function),
    );
    expect(sets).toEqual([
      { resolution: "expired", resolvedAt: ["expires_at"] },
    ]);
    expect(wheres).toEqual([
      [
        "and",
        ["eq", "id", L1.id],
        ["eq", "org_id", L1.orgId],
        ["eq", "workspace_id", L1.workspaceId],
        ["isNull", "mandate_id"],
        ["isNull", "resolution"],
        ["isNull", "token_used_at"],
        ["lt", "expires_at", expect.any(Date)],
      ],
    ]);
    expect(mocks.lockMandate).not.toHaveBeenCalled();
    expect(mocks.expireApproval).not.toHaveBeenCalled();
  });

  it("does not count an ordinary approval resolved between the scan and update", async () => {
    scans([], [{ ...L1, mandateId: null }]);
    const { tx } = makeTenantTx([]);
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 0,
    });
    expect(mocks.lockMandate).not.toHaveBeenCalled();
    expect(mocks.expireApproval).not.toHaveBeenCalled();
  });

  it("voids a lapsed approval under its mandate's lock in the mandate's tenant scope", async () => {
    scans([], [L1]);
    const { tx } = makeTenantTx();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    const locked = { id: "m-c", status: "active" };
    mocks.lockMandate.mockResolvedValueOnce(locked);

    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 1,
    });
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: "org-3", workspaceId: "ws-3" },
      expect.any(Function),
    );
    expect(mocks.lockMandate).toHaveBeenCalledWith(tx, "m-c");
    expect(mocks.expireApproval).toHaveBeenCalledWith(
      tx,
      locked,
      L1,
      expect.any(Date),
    );
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("skips a lapsed approval whose mandate row is gone, and logs a failing row before voiding the next", async () => {
    scans([], [L1, L2]);
    mocks.lockMandate
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("lock timeout"));
    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 0,
    });
    expect(mocks.expireApproval).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "apr-2" }),
      "mandate.expiry: failed for approval (retried next run)",
    );

    scans([], [L2]);
    mocks.lockMandate.mockResolvedValueOnce({ id: "m-d", status: "active" });
    await expect(capturedHandler!({ step })).resolves.toEqual({
      expired: 0,
      voided: 1,
    });
  });
});
