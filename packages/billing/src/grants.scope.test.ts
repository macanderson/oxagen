/**
 * grants.scope.test.ts — regression for the tenant-scope seam of grantFreeCredits.
 *
 * grantFreeCredits runs right after org creation (the deprecated app's
 * onboarding action; `create_org` writes the grant on its own org transaction)
 * where there
 * is NO active tenant scope. It must use
 * the SYSTEM seam (withSystemDb); using withTenantDb throws TenantScopeError
 * ("no_tenant_scope") under enforced RLS and silently drops the $5 signup grant
 * (the callers catch-and-log). This pins it to the system seam so the regression
 * cannot recur. — OXA-1515
 *
 * Fails before the fix (grantFreeCredits used withTenantDb), passes after.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { tenantSeam, systemSeam } = vi.hoisted(() => ({
  tenantSeam: vi.fn(),
  systemSeam: vi.fn(),
}));

/** Minimal tx satisfying the ledger-insert → lot-insert → balance-upsert chain. */
function makeTx() {
  let call = 0;
  return {
    // The debt settlement's read of org_billing_settings: no row, nothing owed.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ for: vi.fn(async () => []) })),
      })),
    })),
    insert: vi.fn(() => {
      call++;
      if (call === 1) {
        // credit_ledger idempotency insert
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "ledger-1" }]),
            }),
          }),
        };
      }
      if (call === 2) {
        // credit_lots insert
        return { values: vi.fn().mockResolvedValue(undefined) };
      }
      // credit_balances upsert
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      };
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: tenantSeam,
    withSystemDb: systemSeam,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// grants.ts imports these at module load; stub to avoid side effects.
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));
vi.mock("./client", () => ({
  billingProvider: () => ({ getCheckoutSessionCreditPacks: vi.fn() }),
}));
vi.mock("./subscriptions", () => ({ syncSubscriptionFromStripe: vi.fn() }));

import { grantFreeCredits } from "./grants";

describe("grantFreeCredits — system seam (no tenant scope required)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = makeTx();
    // Both seams execute the callback against the tx so the grant body runs;
    // the assertion is about WHICH seam grantFreeCredits chose.
    tenantSeam.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    systemSeam.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
  });

  it("uses withSystemDb and never withTenantDb (works with no active tenant scope)", async () => {
    await grantFreeCredits("org-1");

    expect(systemSeam).toHaveBeenCalledTimes(1);
    expect(tenantSeam).not.toHaveBeenCalled();
  });

  it("writes the ledger row, lot, and balance through the system seam", async () => {
    let txSeen: { insert: ReturnType<typeof vi.fn> } | undefined;
    systemSeam.mockImplementation(async (fn: (t: unknown) => unknown) => {
      const tx = makeTx();
      txSeen = tx;
      return fn(tx);
    });

    await grantFreeCredits("org-1");

    // ledger insert + lot insert + balance upsert = 3 inserts.
    expect(txSeen?.insert).toHaveBeenCalledTimes(3);
  });
});
