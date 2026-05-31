/**
 * Unit tests for ensureStripeCustomer
 * (packages/billing/src/customers.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → stripeClient() (no live Stripe API)
 *
 * Scenarios:
 *  1. Existing customer id found on a subscription row → returned immediately,
 *     no Stripe API call.
 *  2. No subscription row, but Stripe customer search finds a match → returns
 *     the found customer id.
 *  3. No subscription row, Stripe search returns empty → creates a new Stripe
 *     customer and returns its id.
 *  4. Tenant not found in DB → throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Stripe client mock
// ---------------------------------------------------------------------------

const stripeCustomersMock = {
  search: vi.fn(),
  create: vi.fn(),
};

vi.mock("../client.js", () => ({
  stripeClient: () => ({ customers: stripeCustomersMock }),
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

vi.mock("@oxagen/database", () => ({
  db: () => dbMocks,
  schema: {
    organizations: { id: "organizations.id" },
    subscriptions: { orgId: "subscriptions.orgId" },
  },
}));

// Import after mocks.
const { ensureStripeCustomer } = await import("../customers.js");

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

  it("existing customer on subscription row — returns without calling Stripe", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(FAKE_ORG);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_existing_001",
    });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_existing_001");
    expect(stripeCustomersMock.search).not.toHaveBeenCalled();
    expect(stripeCustomersMock.create).not.toHaveBeenCalled();
  });

  it("no subscription row, Stripe search finds customer — returns found id", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(FAKE_ORG);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
    stripeCustomersMock.search.mockResolvedValue({
      data: [{ id: "cus_found_001" }],
    });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_found_001");
    expect(stripeCustomersMock.search).toHaveBeenCalledOnce();
    expect(stripeCustomersMock.create).not.toHaveBeenCalled();
  });

  it("no subscription row, Stripe search empty — creates new customer and returns id", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(FAKE_ORG);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
    stripeCustomersMock.search.mockResolvedValue({ data: [] });
    stripeCustomersMock.create.mockResolvedValue({ id: "cus_new_001" });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_new_001");
    expect(stripeCustomersMock.create).toHaveBeenCalledOnce();
    // Verify org metadata is passed to Stripe.
    const firstCall = stripeCustomersMock.create.mock.calls[0];
    expect(firstCall).toBeDefined();
    const createArgs = firstCall![0] as { metadata: Record<string, string> };
    expect(createArgs.metadata.org_id).toBe("org-abc");
    expect(createArgs.metadata.tenant_slug).toBe("acme");
  });

  it("tenant not found in DB — throws with tenant id in message", async () => {
    dbMocks.query.organizations.findFirst.mockResolvedValue(undefined);

    await expect(ensureStripeCustomer("org-missing")).rejects.toThrow("org-missing");
    expect(stripeCustomersMock.search).not.toHaveBeenCalled();
    expect(stripeCustomersMock.create).not.toHaveBeenCalled();
  });
});
