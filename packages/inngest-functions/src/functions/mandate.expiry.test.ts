/**
 * mandate/expiry (ADR-059 decision 7).
 *
 * Guards and their negatives:
 *   - nothing due → no tenant scope entered, no event
 *   - a due mandate: the lock is taken in its own tenant scope, parked
 *     reservations are released, its unresolved approval rows expire, the
 *     status flips to expired and one mandate.expired event is emitted
 *   - a mandate revoked between the scan and the lock is skipped: no
 *     release, no update, no event
 *   - a failure on one mandate is logged and the next still expires
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));
vi.mock("@oxagen/database", () => ({
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
    approvalRequests: { mandateId: "mandate_id", resolution: "resolution" },
  },
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));
vi.mock("@oxagen/rules", () => ({
  lockMandate: mocks.lockMandate,
  releaseParked: mocks.releaseParked,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  isNull: (a: unknown) => a,
  lt: (...a: unknown[]) => a,
}));
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

function scanReturns(rows: Due[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mocks.withSystemDb.mockImplementationOnce(
    async (fn: (tx: unknown) => unknown) => fn({ select: () => ({ from }) }),
  );
}

/** A tenant tx whose updates record their SET values. */
function makeTenantTx() {
  const sets: Record<string, unknown>[] = [];
  const tx = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { tx, sets };
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runInTenantScope.mockImplementation(
    async (_scope: unknown, fn: () => unknown) => fn(),
  );
});

describe("mandate/expiry", () => {
  it("does nothing when no mandate is past its validity window", async () => {
    scanReturns([]);
    await expect(capturedHandler!({ step })).resolves.toEqual({ expired: 0 });
    expect(mocks.runInTenantScope).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("expires a due mandate in its own tenant scope under the lock, releasing parked calls and emitting one event", async () => {
    scanReturns([A]);
    const { tx, sets } = makeTenantTx();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    mocks.lockMandate.mockResolvedValueOnce({ id: A.id, status: "active" });

    await expect(capturedHandler!({ step })).resolves.toEqual({ expired: 1 });

    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      expect.any(Function),
    );
    expect(mocks.lockMandate).toHaveBeenCalledWith(tx, A.id);
    expect(mocks.releaseParked).toHaveBeenCalledWith(tx, A.id);
    expect(sets[0]).toMatchObject({ resolution: "expired" });
    expect(sets[1]).toMatchObject({ status: "expired" });
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
    scanReturns([A]);
    const { tx, sets } = makeTenantTx();
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => unknown) => fn(tx),
    );
    mocks.lockMandate.mockResolvedValueOnce({ id: A.id, status: "revoked" });

    await expect(capturedHandler!({ step })).resolves.toEqual({ expired: 0 });
    expect(mocks.releaseParked).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("logs a failing mandate and still expires the next", async () => {
    scanReturns([A, B]);
    mocks.withTenantDb
      .mockImplementationOnce(async () => {
        throw new Error("lock timeout");
      })
      .mockImplementationOnce(async (fn: (t: unknown) => unknown) =>
        fn(makeTenantTx().tx),
      );
    mocks.lockMandate.mockResolvedValueOnce({ id: B.id, status: "active" });

    await expect(capturedHandler!({ step })).resolves.toEqual({ expired: 1 });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mandateId: "mnd_a" }),
      "mandate.expiry: failed for mandate (retried next run)",
    );
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-2" }),
    );
  });
});
