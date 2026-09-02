/**
 * Unit tests for ensureStripeCustomer
 * (packages/billing/src/customers.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → billingProvider() (neutral BillingProvider interface)
 *
 * Scenarios:
 *  1. Existing customer id found on a subscription row → returned immediately,
 *     no provider API call.
 *  2. No subscription row, provider search finds a match → returns the found id.
 *  3. No subscription row, provider search returns null → creates a new customer
 *     and returns its id.
 *  4. Tenant not found in DB → throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const findCustomerByOrgIdMock = vi.fn();
const createCustomerMock = vi.fn();

vi.mock("./client", () => ({
  billingProvider: () => ({
    findCustomerByOrgId: findCustomerByOrgIdMock,
    createCustomer: createCustomerMock,
  }),
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const dbMocks = {
  query: {
    organizations: { findFirst: vi.fn() },
    subscriptions: { findFirst: vi.fn() },
  },
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbMocks,
    withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
});

// Import after mocks.
const { ensureStripeCustomer } = await import("./customers");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_ORG = { id: "org-abc", name: "Acme Corp", slug: "acme" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureStripeCustomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("existing customer on subscription row — returns without calling provider", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(FAKE_ORG);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_existing_001",
    });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_existing_001");
    expect(findCustomerByOrgIdMock).not.toHaveBeenCalled();
    expect(createCustomerMock).not.toHaveBeenCalled();
  });

  it("no subscription row, provider search finds customer — returns found id", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(FAKE_ORG);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
    findCustomerByOrgIdMock.mockResolvedValue({ id: "cus_found_001" });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_found_001");
    expect(findCustomerByOrgIdMock).toHaveBeenCalledOnce();
    expect(createCustomerMock).not.toHaveBeenCalled();
  });

  it("no subscription row, provider search returns null — creates new customer and returns id", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(FAKE_ORG);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_new_001");

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_new_001");
    expect(createCustomerMock).toHaveBeenCalledOnce();
    // Verify org metadata is passed to provider.
    const createArgs = createCustomerMock.mock.calls[0]![0] as {
      name: string;
      metadata: Record<string, string>;
    };
    expect(createArgs.metadata.org_id).toBe("org-abc");
    expect(createArgs.metadata.tenant_slug).toBe("acme");
  });

  it("tenant not found in DB — throws with tenant id in message", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(undefined);

    await expect(ensureStripeCustomer("org-missing")).rejects.toThrow(
      "org-missing",
    );
    expect(findCustomerByOrgIdMock).not.toHaveBeenCalled();
    expect(createCustomerMock).not.toHaveBeenCalled();
  });
});
