import type { BillingSubscriptionReadOutput } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { getScope } from "@oxagen/tenancy";
import { describe, expect, it, vi } from "vitest";
import { BACKING } from "@/data/backing";
import { NO_GAP } from "@/data/not-backed";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { InvoiceRow } from "./mappers/billing";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CapabilityError";
    }
  }
  return {
    CapabilityError,
    registry: { loaded: 0 },
    invoke:
      vi.fn<
        (
          name: string,
          input: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<unknown>
      >(),
    getCapability: vi.fn<(name: string) => unknown>(),
    getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    withTenantDb: vi.fn<(fn: (tx: unknown) => unknown) => Promise<unknown>>(),
  };
});

vi.mock("@oxagen/handlers/register", () => {
  mocks.registry.loaded += 1;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: mocks.CapabilityError,
  invoke: mocks.invoke,
  getCapability: mocks.getCapability,
}));
vi.mock("@/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@oxagen/database", () => ({
  schema: {
    plans: { tier: "plans.tier", slug: "plans.slug" },
    invoices: {
      number: "invoices.number",
      status: "invoices.status",
      amountDueCents: "invoices.amount_due_cents",
      currency: "invoices.currency",
      periodStart: "invoices.period_start",
      orgId: "invoices.org_id",
      createdAt: "invoices.created_at",
    },
  },
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  ne: (column: unknown, value: unknown) => ({ ne: [column, value] }),
  desc: (column: unknown) => ({ desc: column }),
}));

import {
  type BillingLiveDeps,
  createLiveBilling,
  isCapabilityDenial,
  liveBilling,
  liveBillingDeps,
} from "./billing";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const USER = "0192d4a8-7c1e-7a00-8000-0000000000a1";

const ACTIVE: BillingSubscriptionReadOutput = {
  subscription: {
    publicId: "sub_2kQ9v7XbT1c4Lm8Nw3Pq5R",
    status: "active",
    planSlug: "build-v2",
    billingInterval: "month",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    seatCount: 5,
  },
  creditBalanceCents: 2_400,
  periodUsage: null,
};

const PAID: InvoiceRow = {
  number: "8F2A1C3D-0007",
  status: "paid",
  amountDueCents: 71_520,
  currency: "usd",
  periodStart: new Date("2026-08-01T00:00:00.000Z"),
};

function fakeDeps(over: Partial<BillingLiveDeps> = {}) {
  return {
    principal: vi.fn<BillingLiveDeps["principal"]>(() => Promise.resolve(USER)),
    subscription: vi.fn<BillingLiveDeps["subscription"]>(() =>
      Promise.resolve(ACTIVE),
    ),
    planTier: vi.fn<BillingLiveDeps["planTier"]>(() =>
      Promise.resolve("build"),
    ),
    invoiceRows: vi.fn<BillingLiveDeps["invoiceRows"]>(() =>
      Promise.resolve([]),
    ),
    ...over,
  };
}

const DENIED = { ok: false, reason: "denied", permission: "org.billing" };

describe("liveBilling.plan", () => {
  it("reads get_subscription as the signed-in person and maps the plan tier", async () => {
    const deps = fakeDeps();
    await expect(createLiveBilling(deps).plan(SCOPE)).resolves.toEqual({
      ok: true,
      value: {
        plan: "team",
        status: "active",
        nextInvoiceOn: "2026-10-01",
        discount: null,
      },
    });
    expect(deps.subscription).toHaveBeenCalledWith({
      scope: SCOPE,
      userId: USER,
    });
    expect(deps.planTier).toHaveBeenCalledWith(SCOPE, "build-v2");
  });

  it("with no subscription it reads no plan row and is not recorded yet", async () => {
    const deps = fakeDeps({
      subscription: vi.fn(() =>
        Promise.resolve({ ...ACTIVE, subscription: null }),
      ),
    });
    await expect(createLiveBilling(deps).plan(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M0",
      gap: NO_GAP,
    });
    expect(deps.planTier).not.toHaveBeenCalled();
  });

  it("without a session it is denied and never reaches the kernel", async () => {
    const deps = fakeDeps({ principal: vi.fn(() => Promise.resolve(null)) });
    await expect(createLiveBilling(deps).plan(SCOPE)).resolves.toEqual(DENIED);
    expect(deps.subscription).not.toHaveBeenCalled();
  });

  it.each([
    "authz_denied",
    "pending_approval",
    "surface_denied",
    "capability_not_installed",
  ])("a kernel %s is the page's denied state", async (code) => {
    const deps = fakeDeps({
      subscription: vi.fn(() =>
        Promise.reject(
          new mocks.CapabilityError("get_subscription", code, "no"),
        ),
      ),
    });
    await expect(createLiveBilling(deps).plan(SCOPE)).resolves.toEqual(DENIED);
    expect(deps.planTier).not.toHaveBeenCalled();
  });

  it("a store failure is thrown to the error boundary, not turned into a denial", async () => {
    const failure = new mocks.CapabilityError(
      "get_subscription",
      "invalid_output",
      "bad",
    );
    const deps = fakeDeps({
      subscription: vi.fn(() => Promise.reject(failure)),
    });
    await expect(createLiveBilling(deps).plan(SCOPE)).rejects.toBe(failure);
    const down = new Error("connect ECONNREFUSED 127.0.0.1:5433");
    await expect(
      createLiveBilling(
        fakeDeps({ planTier: vi.fn(() => Promise.reject(down)) }),
      ).plan(SCOPE),
    ).rejects.toBe(down);
  });
});

describe("liveBilling.invoices", () => {
  it("an organization with no issued invoice has an empty list", async () => {
    const deps = fakeDeps();
    await expect(createLiveBilling(deps).invoices(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(deps.invoiceRows).toHaveBeenCalledWith(SCOPE);
  });

  it("issued invoices read as not backed on G13 (no run count is recorded)", async () => {
    const deps = fakeDeps({
      invoiceRows: vi.fn(() => Promise.resolve([PAID])),
    });
    await expect(createLiveBilling(deps).invoices(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G13",
    });
  });

  it("a person get_subscription denies never reaches the invoices table", async () => {
    const deps = fakeDeps({
      subscription: vi.fn(() =>
        Promise.reject(
          new mocks.CapabilityError("get_subscription", "authz_denied", "no"),
        ),
      ),
      invoiceRows: vi.fn(() => Promise.resolve([PAID])),
    });
    await expect(createLiveBilling(deps).invoices(SCOPE)).resolves.toEqual(
      DENIED,
    );
    expect(deps.invoiceRows).not.toHaveBeenCalled();
  });

  it("without a session the invoices table is never read", async () => {
    const deps = fakeDeps({ principal: vi.fn(() => Promise.resolve(null)) });
    await expect(createLiveBilling(deps).invoices(SCOPE)).resolves.toEqual(
      DENIED,
    );
    expect(deps.invoiceRows).not.toHaveBeenCalled();
  });
});

describe("liveBilling: the per-run allowance and meters (G13)", () => {
  it.each(["allowance", "meters"] as const)(
    "%s names its milestone and gap",
    async (method) => {
      const deps = fakeDeps();
      await expect(createLiveBilling(deps)[method](SCOPE)).resolves.toEqual({
        ok: false,
        reason: "not_backed",
        milestone: BACKING.billing[method].milestone,
        gap: BACKING.billing[method].gap,
      });
      expect(BACKING.billing[method]).toMatchObject({
        milestone: "M2",
        gap: "G13",
      });
      expect(deps.principal).not.toHaveBeenCalled();
    },
  );
});

describe("isCapabilityDenial", () => {
  it("is true only for kernel denial codes", () => {
    expect(
      isCapabilityDenial(new mocks.CapabilityError("x", "authz_denied", "")),
    ).toBe(true);
    expect(
      isCapabilityDenial(new mocks.CapabilityError("x", "invalid_input", "")),
    ).toBe(false);
    expect(
      isCapabilityDenial(
        Object.assign(new Error("x"), { code: "authz_denied" }),
      ),
    ).toBe(false);
  });
});

describe("liveBillingDeps (production I/O)", () => {
  it("principal is the session user, or null", async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: USER } });
    await expect(liveBillingDeps.principal()).resolves.toBe(USER);
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveBillingDeps.principal()).resolves.toBeNull();
  });

  it("subscription invokes get_subscription in the tenant scope and parses the output", async () => {
    mocks.getCapability.mockReturnValue({ name: "get_subscription" });
    let seenScope: unknown;
    mocks.invoke.mockImplementation(() => {
      seenScope = getScope();
      return Promise.resolve(ACTIVE);
    });
    await expect(
      liveBillingDeps.subscription({ scope: SCOPE, userId: USER }),
    ).resolves.toEqual(ACTIVE);
    expect(mocks.registry.loaded).toBe(1);
    const [name, input, ctx] = mocks.invoke.mock.calls[0] ?? [];
    expect(name).toBe("get_subscription");
    expect(input).toEqual({});
    expect(ctx).toMatchObject({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      userId: USER,
      apiKeyId: null,
      surface: "app",
    });
    expect(seenScope).toMatchObject(SCOPE);
  });

  it("refuses a contract the kernel has not registered", async () => {
    mocks.getCapability.mockReturnValue(undefined);
    await expect(
      liveBillingDeps.subscription({ scope: SCOPE, userId: USER }),
    ).rejects.toBeInstanceOf(ToolNotRegistered);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("an output the contract rejects never reaches the mapper", async () => {
    mocks.getCapability.mockReturnValue({ name: "get_subscription" });
    mocks.invoke.mockResolvedValue({ subscription: { status: 3 } });
    await expect(
      liveBillingDeps.subscription({ scope: SCOPE, userId: USER }),
    ).rejects.toBeInstanceOf(ContractOutputMismatch);
  });

  it("planTier selects plans.tier by slug under tenant scope", async () => {
    const calls: Record<string, unknown> = {};
    const tx = {
      select: (cols: unknown) => {
        calls.select = cols;
        return tx;
      },
      from: (table: unknown) => {
        calls.from = table;
        return tx;
      },
      where: (cond: unknown) => {
        calls.where = cond;
        return tx;
      },
      limit: (n: number) => {
        calls.limit = n;
        return Promise.resolve([{ tier: "scale" }]);
      },
    };
    let seenScope: unknown;
    mocks.withTenantDb.mockImplementation((fn) => {
      seenScope = getScope();
      return Promise.resolve(fn(tx));
    });
    await expect(liveBillingDeps.planTier(SCOPE, "scale-v2")).resolves.toBe(
      "scale",
    );
    expect(calls).toEqual({
      select: { tier: "plans.tier" },
      from: { tier: "plans.tier", slug: "plans.slug" },
      where: { eq: ["plans.slug", "scale-v2"] },
      limit: 1,
    });
    expect(seenScope).toMatchObject(SCOPE);

    tx.limit = () => Promise.resolve([]);
    await expect(liveBillingDeps.planTier(SCOPE, "gone")).resolves.toBeNull();
  });

  it("invoiceRows reads the organization's issued invoices, newest first, under tenant scope", async () => {
    const calls: Record<string, unknown> = {};
    const tx = {
      select: (cols: unknown) => {
        calls.select = cols;
        return tx;
      },
      from: () => tx,
      where: (cond: unknown) => {
        calls.where = cond;
        return tx;
      },
      orderBy: (order: unknown) => {
        calls.orderBy = order;
        return Promise.resolve([PAID]);
      },
    };
    let seenScope: unknown;
    mocks.withTenantDb.mockImplementation((fn) => {
      seenScope = getScope();
      return Promise.resolve(fn(tx));
    });
    await expect(liveBillingDeps.invoiceRows(SCOPE)).resolves.toEqual([PAID]);
    expect(calls).toEqual({
      select: {
        number: "invoices.number",
        status: "invoices.status",
        amountDueCents: "invoices.amount_due_cents",
        currency: "invoices.currency",
        periodStart: "invoices.period_start",
      },
      where: {
        and: [
          { eq: ["invoices.org_id", SCOPE.orgId] },
          { ne: ["invoices.status", "draft"] },
        ],
      },
      orderBy: { desc: "invoices.created_at" },
    });
    expect(seenScope).toMatchObject(SCOPE);
  });

  it("an invalid scope fails before any query", async () => {
    await expect(
      liveBillingDeps.invoiceRows({ orgId: "", workspaceId: "" }),
    ).rejects.toThrow();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("liveBilling is wired to the production I/O", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveBilling.plan(SCOPE)).resolves.toEqual(DENIED);
  });
});
