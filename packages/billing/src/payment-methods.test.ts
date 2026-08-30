/**
 * Unit tests for packages/billing/src/payment-methods.ts
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → billingProvider()
 *  - ../customers.js  → ensureStripeCustomer
 *
 * Covers:
 *  1. listOrgPaymentMethods — returns non-deleted rows from DB
 *  2. createPaymentMethodSetupIntent — resolves customerId + calls provider
 *  3. syncPaymentMethodsFromStripe — upserts cards, clears stale defaults, soft-deletes removed cards
 *  4. setOrgDefaultPaymentMethod — calls provider + flips isDefault in DB
 *  5. removeOrgPaymentMethod — detaches + soft-deletes a non-default card
 *  6. removeOrgPaymentMethod — promotes next card to default when removed card was default
 *  7. removeOrgPaymentMethod — throws LastPaymentMethodError when removing last card on active sub
 *  8. isLastPaymentMethodError type guard
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Provider mock
// ---------------------------------------------------------------------------

const listPaymentMethodsMock = vi.fn();
const getDefaultPaymentMethodIdMock = vi.fn();
const setDefaultPaymentMethodMock = vi.fn().mockResolvedValue(undefined);
const detachPaymentMethodMock = vi.fn().mockResolvedValue(undefined);
const createSetupIntentMock = vi.fn();

vi.mock("./client", () => ({
  billingProvider: () => ({
    listPaymentMethods: listPaymentMethodsMock,
    getDefaultPaymentMethodId: getDefaultPaymentMethodIdMock,
    setDefaultPaymentMethod: setDefaultPaymentMethodMock,
    detachPaymentMethod: detachPaymentMethodMock,
    createSetupIntent: createSetupIntentMock,
  }),
}));

// ---------------------------------------------------------------------------
// customers mock
// ---------------------------------------------------------------------------

const ensureStripeCustomerMock = vi.fn().mockResolvedValue("cus_default");

vi.mock("./customers", () => ({
  ensureStripeCustomer: ensureStripeCustomerMock,
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

// Mutable state so tests can configure it.
let _findManyResult: Array<Record<string, unknown>> = [];
let _findFirstResult: Record<string, unknown> | undefined = undefined;

const insertValuesMock = vi.fn();
const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
insertValuesMock.mockReturnValue({
  onConflictDoUpdate: onConflictDoUpdateMock,
});
const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

const updateSetMock = vi.fn();
const updateWhereMock = vi.fn().mockResolvedValue(undefined);
updateSetMock.mockReturnValue({ where: updateWhereMock });
const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

// Transaction runs the callback with the same mock surface (insert/update),
// so default-flag flips inside db().transaction(...) exercise updateMock.
const transactionMock = vi.fn(
  async (cb: (tx: typeof dbMocks) => Promise<unknown>) => cb(dbMocks),
);

const dbMocks = {
  insert: insertMock,
  update: updateMock,
  transaction: transactionMock,
  query: {
    paymentMethods: {
      findMany: vi.fn().mockImplementation(async () => _findManyResult),
      findFirst: vi.fn().mockImplementation(async () => _findFirstResult),
    },
    subscriptions: {
      findFirst: vi.fn().mockResolvedValue(undefined),
    },
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
const {
  listOrgPaymentMethods,
  createPaymentMethodSetupIntent,
  syncPaymentMethodsFromStripe,
  setOrgDefaultPaymentMethod,
  removeOrgPaymentMethod,
  LastPaymentMethodError,
  isLastPaymentMethodError,
} = await import("./payment-methods");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbPm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stripePaymentMethodId: "pm_001",
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2028,
    isDefault: false,
    deletedAt: null,
    id: "uuid-001",
    orgId: "org-001",
    stripeCustomerId: "cus_001",
    ...overrides,
  };
}

function makeProviderPm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pm_001",
    customerId: "cus_001",
    type: "card",
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2028,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listOrgPaymentMethods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _findManyResult = [];
  });

  it("returns mapped views from the DB", async () => {
    _findManyResult = [
      makeDbPm({ stripePaymentMethodId: "pm_001", isDefault: true }),
      makeDbPm({
        stripePaymentMethodId: "pm_002",
        brand: "mastercard",
        last4: "1234",
        isDefault: false,
      }),
    ];

    const result = await listOrgPaymentMethods("org-001");

    expect(result).toHaveLength(2);
    expect(result[0]!.stripePaymentMethodId).toBe("pm_001");
    expect(result[0]!.isDefault).toBe(true);
    expect(result[1]!.brand).toBe("mastercard");
    expect(result[1]!.isDefault).toBe(false);
  });

  it("returns empty array when no payment methods exist", async () => {
    _findManyResult = [];
    const result = await listOrgPaymentMethods("org-empty");
    expect(result).toHaveLength(0);
  });
});

describe("createPaymentMethodSetupIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _findFirstResult = undefined;
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
  });

  it("resolves customer from subscription row and creates SetupIntent", async () => {
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_from_sub",
    });
    createSetupIntentMock.mockResolvedValue({
      clientSecret: "seti_secret_abc",
      setupIntentId: "seti_abc",
    });

    const result = await createPaymentMethodSetupIntent("org-001");

    expect(createSetupIntentMock).toHaveBeenCalledWith("cus_from_sub");
    expect(result.clientSecret).toBe("seti_secret_abc");
  });

  it("falls back to ensureStripeCustomer when no subscription row exists", async () => {
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
    ensureStripeCustomerMock.mockResolvedValue("cus_new");
    createSetupIntentMock.mockResolvedValue({
      clientSecret: "seti_secret_new",
      setupIntentId: "seti_new",
    });

    const result = await createPaymentMethodSetupIntent("org-001");

    expect(ensureStripeCustomerMock).toHaveBeenCalledWith("org-001");
    expect(result.clientSecret).toBe("seti_secret_new");
  });
});

describe("syncPaymentMethodsFromStripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _findManyResult = [];
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_001",
    });
    insertValuesMock.mockReturnValue({
      onConflictDoUpdate: onConflictDoUpdateMock,
    });
    insertMock.mockReturnValue({ values: insertValuesMock });
    updateSetMock.mockReturnValue({ where: updateWhereMock });
    updateMock.mockReturnValue({ set: updateSetMock });
  });

  it("upserts each card returned by the provider", async () => {
    listPaymentMethodsMock.mockResolvedValue([
      makeProviderPm({ id: "pm_001" }),
      makeProviderPm({ id: "pm_002", brand: "mastercard", last4: "5555" }),
    ]);
    getDefaultPaymentMethodIdMock.mockResolvedValue("pm_001");
    _findManyResult = [
      makeDbPm({ stripePaymentMethodId: "pm_001" }),
      makeDbPm({ stripePaymentMethodId: "pm_002" }),
    ];

    await syncPaymentMethodsFromStripe("org-001");

    // Batch upsert — both cards in a single insert().values().onConflictDoUpdate().
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(onConflictDoUpdateMock).toHaveBeenCalledTimes(1);
    // Verify both cards were included in the batch.
    const valuesCall = insertValuesMock.mock.calls[0]!;
    expect(valuesCall[0]).toHaveLength(2);
  });

  it("soft-deletes DB rows for cards no longer in Stripe", async () => {
    listPaymentMethodsMock.mockResolvedValue([
      makeProviderPm({ id: "pm_001" }),
    ]);
    getDefaultPaymentMethodIdMock.mockResolvedValue("pm_001");
    // DB has two rows; Stripe only returns one.
    _findManyResult = [
      makeDbPm({ stripePaymentMethodId: "pm_001", id: "uuid-001" }),
      makeDbPm({ stripePaymentMethodId: "pm_stale", id: "uuid-stale" }),
    ];

    await syncPaymentMethodsFromStripe("org-001");

    // update() should have been called to soft-delete the stale row.
    expect(updateMock).toHaveBeenCalled();
    const setCalls = updateSetMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).deletedAt,
    );
    expect(setCalls.some((v) => v !== undefined)).toBe(true);
  });

  it("calls no inserts when Stripe returns no cards", async () => {
    listPaymentMethodsMock.mockResolvedValue([]);
    getDefaultPaymentMethodIdMock.mockResolvedValue(null);
    _findManyResult = [];

    await syncPaymentMethodsFromStripe("org-001");

    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("setOrgDefaultPaymentMethod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_001",
    });
    updateSetMock.mockReturnValue({ where: updateWhereMock });
    updateMock.mockReturnValue({ set: updateSetMock });
  });

  it("calls provider setDefaultPaymentMethod and updates DB", async () => {
    await setOrgDefaultPaymentMethod("org-001", "pm_new_default");

    expect(setDefaultPaymentMethodMock).toHaveBeenCalledWith(
      "cus_001",
      "pm_new_default",
    );
    // Should have called update() at least twice (clear all, set new).
    expect(updateMock).toHaveBeenCalledTimes(2);
  });
});

describe("removeOrgPaymentMethod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);
    _findManyResult = [];
    updateSetMock.mockReturnValue({ where: updateWhereMock });
    updateMock.mockReturnValue({ set: updateSetMock });
  });

  it("detaches and soft-deletes a non-default card", async () => {
    _findManyResult = [
      makeDbPm({
        stripePaymentMethodId: "pm_001",
        isDefault: false,
        id: "uuid-001",
      }),
      makeDbPm({
        stripePaymentMethodId: "pm_002",
        isDefault: true,
        id: "uuid-002",
      }),
    ];
    dbMocks.query.paymentMethods.findMany.mockResolvedValue(_findManyResult);

    await removeOrgPaymentMethod("org-001", "pm_001");

    expect(detachPaymentMethodMock).toHaveBeenCalledWith("pm_001");
    expect(updateMock).toHaveBeenCalled();
    const setCalls = updateSetMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).deletedAt,
    );
    expect(setCalls.some((v) => v instanceof Date)).toBe(true);
  });

  it("promotes another card to default when removed card was default", async () => {
    _findManyResult = [
      makeDbPm({
        stripePaymentMethodId: "pm_default",
        isDefault: true,
        id: "uuid-001",
      }),
      makeDbPm({
        stripePaymentMethodId: "pm_other",
        isDefault: false,
        id: "uuid-002",
      }),
    ];
    dbMocks.query.paymentMethods.findMany.mockResolvedValue(_findManyResult);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_001",
    });

    await removeOrgPaymentMethod("org-001", "pm_default");

    // detachPaymentMethod called for the removed card.
    expect(detachPaymentMethodMock).toHaveBeenCalledWith("pm_default");
    // setDefaultPaymentMethod called to promote the next card.
    expect(setDefaultPaymentMethodMock).toHaveBeenCalledWith(
      "cus_001",
      "pm_other",
    );
  });

  it("throws LastPaymentMethodError when removing last card on active subscription", async () => {
    _findManyResult = [
      makeDbPm({
        stripePaymentMethodId: "pm_only",
        isDefault: true,
        id: "uuid-001",
      }),
    ];
    dbMocks.query.paymentMethods.findMany.mockResolvedValue(_findManyResult);

    // Simulate an active subscription.
    dbMocks.query.subscriptions.findFirst.mockResolvedValueOnce({
      id: "uuid-sub",
    }); // active subscription check

    await expect(removeOrgPaymentMethod("org-001", "pm_only")).rejects.toThrow(
      LastPaymentMethodError,
    );

    // Provider should NOT have been called.
    expect(detachPaymentMethodMock).not.toHaveBeenCalled();
  });

  it("throws when the card does not belong to the org", async () => {
    _findManyResult = [
      makeDbPm({
        stripePaymentMethodId: "pm_other",
        isDefault: false,
        id: "uuid-001",
      }),
    ];
    dbMocks.query.paymentMethods.findMany.mockResolvedValue(_findManyResult);

    await expect(
      removeOrgPaymentMethod("org-001", "pm_unknown"),
    ).rejects.toThrow("pm_unknown");
    expect(detachPaymentMethodMock).not.toHaveBeenCalled();
  });

  it("propagates error when default-promotion Stripe call fails (no silent swallow)", async () => {
    // Verifies fix for payment-methods.ts:407 swallowed catch.
    // After the removed card is soft-deleted, the org has zero isDefault=true cards.
    // If the Stripe call to promote the next card fails, the error must NOT be
    // swallowed — callers need to know so they can trigger a re-sync.
    _findManyResult = [
      makeDbPm({
        stripePaymentMethodId: "pm_default",
        isDefault: true,
        id: "uuid-001",
      }),
      makeDbPm({
        stripePaymentMethodId: "pm_other",
        isDefault: false,
        id: "uuid-002",
      }),
    ];
    dbMocks.query.paymentMethods.findMany.mockResolvedValue(_findManyResult);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_001",
    });

    // Simulate Stripe failing to update the default.
    setDefaultPaymentMethodMock.mockRejectedValueOnce(
      new Error("stripe_error: network timeout"),
    );

    await expect(
      removeOrgPaymentMethod("org-001", "pm_default"),
    ).rejects.toThrow("stripe_error: network timeout");

    // The removed card was still detached (that already succeeded before promotion).
    expect(detachPaymentMethodMock).toHaveBeenCalledWith("pm_default");
    // Promotion was attempted.
    expect(setDefaultPaymentMethodMock).toHaveBeenCalledWith(
      "cus_001",
      "pm_other",
    );
  });

  it("propagates error when default-promotion DB update fails (no silent swallow)", async () => {
    // Same bug class but the Stripe call succeeds and the DB update fails.
    _findManyResult = [
      makeDbPm({
        stripePaymentMethodId: "pm_default",
        isDefault: true,
        id: "uuid-001",
      }),
      makeDbPm({
        stripePaymentMethodId: "pm_other",
        isDefault: false,
        id: "uuid-002",
      }),
    ];
    dbMocks.query.paymentMethods.findMany.mockResolvedValue(_findManyResult);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeCustomerId: "cus_001",
    });
    setDefaultPaymentMethodMock.mockResolvedValueOnce(undefined); // Stripe OK

    // The first update (soft-delete of the removed card) succeeds; the SECOND
    // update (promoting the next card to isDefault=true) is the one that fails.
    updateWhereMock.mockResolvedValueOnce(undefined); // soft-delete OK
    updateWhereMock.mockRejectedValueOnce(new Error("db: connection lost")); // promote fails

    await expect(
      removeOrgPaymentMethod("org-001", "pm_default"),
    ).rejects.toThrow("db: connection lost");

    expect(detachPaymentMethodMock).toHaveBeenCalledWith("pm_default");
    expect(setDefaultPaymentMethodMock).toHaveBeenCalledWith(
      "cus_001",
      "pm_other",
    );
  });
});

describe("isLastPaymentMethodError", () => {
  it("returns true for LastPaymentMethodError", () => {
    const err = new LastPaymentMethodError();
    expect(isLastPaymentMethodError(err)).toBe(true);
  });

  it("returns false for plain errors", () => {
    expect(isLastPaymentMethodError(new Error("nope"))).toBe(false);
    expect(isLastPaymentMethodError(null)).toBe(false);
    expect(isLastPaymentMethodError("string")).toBe(false);
  });

  it("LastPaymentMethodError has code = last_payment_method", () => {
    const err = new LastPaymentMethodError();
    expect(err.code).toBe("last_payment_method");
  });
});
