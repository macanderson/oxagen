/**
 * Unit tests for ensureStripeCustomer (packages/billing/src/customers.ts).
 *
 * The database is a small in-memory fake: one organisations row, at most one
 * org_billing_settings row and at most one subscriptions row per test, and
 * an upsert on org_billing_settings that models the production compare-and-
 * swap: `SET stripe_customer_id = CASE WHEN existing IS NOT DISTINCT FROM
 * previousValue THEN excluded ELSE existing END`. `previousValue` is the
 * settings id this call read (null, or a stale id it just rejected), so the
 * row is only overwritten while it still holds that same value; a
 * concurrent caller that already moved the row on wins. The provider is a
 * fake with the three customer methods.
 *
 * Scenarios:
 *  1. The settings column carries a live id → returned; no create, no write.
 *  2. No settings row; a subscription row carries a live id → returned and
 *     the column written.
 *  3. No row anywhere; the provider search finds a live customer → returned
 *     and written.
 *  4. No row anywhere; the search finds nothing → one customer created and
 *     written.
 *  5. Tenant not found → throws.
 *  6. Two purchases by a subscription-less org create one customer even when
 *     the search answers null both times: the second read finds the column.
 *  7. `{ system: true }` runs on withSystemDb with no tenant scope.
 *  8. A concurrent caller's id, stored first, wins over the one this call made.
 *  9. A settings id missing on this Stripe account is overwritten with a new
 *     customer (sandbox cutover / key rotation).
 * 10. A search hit that is missing on this account falls through to create.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const findCustomerByOrgIdMock = vi.fn();
const createCustomerMock = vi.fn();
const customerExistsMock = vi.fn();

vi.mock("./client", () => ({
  billingProvider: () => ({
    findCustomerByOrgId: findCustomerByOrgIdMock,
    createCustomer: createCustomerMock,
    customerExists: customerExistsMock,
  }),
}));

// ---------------------------------------------------------------------------
// DB fake
// ---------------------------------------------------------------------------

interface World {
  org: { id: string; name: string; slug: string } | null;
  settings: { orgId: string; stripeCustomerId: string | null } | null;
  subscription: { stripeCustomerId: string | null } | null;
  /** Every org_billing_settings upsert, in order. */
  upserts: Array<{
    orgId: string;
    stripeCustomerId: string;
    previousValue: string | null;
  }>;
  /** Runs once, inside the upsert, before the fake applies it. */
  beforeUpsert: (() => void) | null;
}

const { seams, world } = vi.hoisted(() => ({
  seams: { tenant: vi.fn(), system: vi.fn() },
  world: {
    org: null,
    settings: null,
    subscription: null,
    upserts: [],
    beforeUpsert: null,
  } as unknown as World,
}));

/**
 * Recognizes the production CASE/IS NOT DISTINCT FROM compare-and-swap
 * expression and pulls out the `previousValue` it was built with.
 *
 * A drizzle `sql` template's `queryChunks` mixes raw text chunks (a
 * `StringChunk`, `.value` a `string[]`) with the interpolated values: the
 * column identifier (a `PgColumn`, twice) and `previousValue` once, as a
 * bare JS primitive (a `string`, or the literal `null`). Skipping the
 * `StringChunk`s and the column (an object that is neither a string nor
 * `null`) leaves exactly the `previousValue` chunk.
 */
function parseCasSql(v: unknown): { previousValue: string | null } | null {
  if (typeof v !== "object" || v === null || !("queryChunks" in v)) {
    return null;
  }
  const chunks = (v as { queryChunks: unknown[] }).queryChunks;
  const isRawText = (chunk: unknown): chunk is { value: string[] } =>
    typeof chunk === "object" &&
    chunk !== null &&
    "value" in chunk &&
    Array.isArray((chunk as { value: unknown }).value);
  const isCas = chunks.some(
    (chunk) =>
      isRawText(chunk) &&
      chunk.value.join("").toLowerCase().includes("is not distinct from"),
  );
  if (!isCas) return null;
  for (const chunk of chunks) {
    if (isRawText(chunk)) continue;
    if (chunk === null) return { previousValue: null };
    if (typeof chunk === "string") return { previousValue: chunk };
  }
  return { previousValue: null };
}

const tx = {
  query: {
    organizations: { findFirst: async () => world.org ?? undefined },
    orgBillingSettings: {
      findFirst: async () =>
        world.settings
          ? { stripeCustomerId: world.settings.stripeCustomerId }
          : undefined,
    },
    subscriptions: { findFirst: async () => world.subscription ?? undefined },
  },
  insert: () => ({
    values: (v: { orgId: string; stripeCustomerId: string }) => ({
      onConflictDoUpdate: (conflict: {
        target: unknown;
        set: Record<string, unknown>;
      }) => ({
        returning: async () => {
          const cas = parseCasSql(conflict.set.stripeCustomerId);
          if (!cas) {
            throw new Error("fake db: upsert must set the CAS expression");
          }
          world.beforeUpsert?.();
          world.beforeUpsert = null;
          world.upserts.push({
            orgId: v.orgId,
            stripeCustomerId: v.stripeCustomerId,
            previousValue: cas.previousValue,
          });
          if (world.settings === null) {
            world.settings = {
              orgId: v.orgId,
              stripeCustomerId: v.stripeCustomerId,
            };
          } else if (world.settings.stripeCustomerId === cas.previousValue) {
            world.settings.stripeCustomerId = v.stripeCustomerId;
          }
          // else: a concurrent write already moved the row past
          // previousValue, so the CAS is a no-op and that winner stands.
          return [{ stripeCustomerId: world.settings.stripeCustomerId }];
        },
      }),
    }),
  }),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: seams.tenant,
    withSystemDb: seams.system,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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
    world.org = FAKE_ORG;
    world.settings = null;
    world.subscription = null;
    world.upserts = [];
    world.beforeUpsert = null;
    seams.tenant.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    seams.system.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    // A stored id is live unless a test says otherwise.
    customerExistsMock.mockResolvedValue(true);
  });

  it("returns the id on org_billing_settings without creating or writing", async () => {
    world.settings = { orgId: "org-abc", stripeCustomerId: "cus_settings_001" };
    world.subscription = { stripeCustomerId: "cus_sub_001" };

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_settings_001");
    expect(customerExistsMock).toHaveBeenCalledWith("cus_settings_001");
    expect(findCustomerByOrgIdMock).not.toHaveBeenCalled();
    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(world.upserts).toEqual([]);
  });

  it("takes the id off a subscription row when the column is unset, and writes the column", async () => {
    world.subscription = { stripeCustomerId: "cus_existing_001" };

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_existing_001");
    expect(customerExistsMock).toHaveBeenCalledWith("cus_existing_001");
    expect(findCustomerByOrgIdMock).not.toHaveBeenCalled();
    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(world.upserts).toEqual([
      {
        orgId: "org-abc",
        stripeCustomerId: "cus_existing_001",
        previousValue: null,
      },
    ]);
  });

  it("no row anywhere, provider search finds the customer — returns the found id and writes it", async () => {
    findCustomerByOrgIdMock.mockResolvedValue({ id: "cus_found_001" });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_found_001");
    expect(findCustomerByOrgIdMock).toHaveBeenCalledOnce();
    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(world.settings).toEqual({
      orgId: "org-abc",
      stripeCustomerId: "cus_found_001",
    });
  });

  it("no row anywhere, search returns null — creates one customer with the org metadata and writes it against an org with no settings row", async () => {
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_new_001");

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_new_001");
    expect(createCustomerMock).toHaveBeenCalledOnce();
    expect(createCustomerMock).toHaveBeenCalledWith({
      name: "Acme Corp",
      metadata: { org_id: "org-abc", tenant_slug: "acme" },
    });
    expect(world.settings).toEqual({
      orgId: "org-abc",
      stripeCustomerId: "cus_new_001",
    });
  });

  it("tenant not found in DB — throws with tenant id in message and writes nothing", async () => {
    world.org = null;

    await expect(ensureStripeCustomer("org-missing")).rejects.toThrow(
      "org-missing",
    );
    expect(findCustomerByOrgIdMock).not.toHaveBeenCalled();
    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(world.upserts).toEqual([]);
  });

  it("two purchases by a subscription-less org create one customer even when the search answers null both times", async () => {
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_new_001");

    const first = await ensureStripeCustomer("org-abc");
    const second = await ensureStripeCustomer("org-abc");

    expect(first).toBe("cus_new_001");
    expect(second).toBe("cus_new_001");
    expect(createCustomerMock).toHaveBeenCalledOnce();
    expect(findCustomerByOrgIdMock).toHaveBeenCalledOnce();
  });

  it("{ system: true } reads and writes on withSystemDb and never enters the tenant seam", async () => {
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_sys_001");

    const result = await ensureStripeCustomer("org-abc", { system: true });

    expect(result).toBe("cus_sys_001");
    expect(seams.system).toHaveBeenCalled();
    expect(seams.tenant).not.toHaveBeenCalled();
  });

  it("a concurrent caller's id, stored first, wins over the one this call made", async () => {
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_mine_001");
    world.beforeUpsert = () => {
      world.settings = {
        orgId: "org-abc",
        stripeCustomerId: "cus_theirs_001",
      };
    };

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_theirs_001");
    expect(world.settings?.stripeCustomerId).toBe("cus_theirs_001");
  });

  it("overwrites a settings id that is missing on this Stripe account", async () => {
    world.settings = { orgId: "org-abc", stripeCustomerId: "cus_stale_001" };
    customerExistsMock.mockImplementation(async (id: string) => {
      return id !== "cus_stale_001";
    });
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_fresh_001");

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_fresh_001");
    expect(customerExistsMock).toHaveBeenCalledWith("cus_stale_001");
    expect(createCustomerMock).toHaveBeenCalledOnce();
    expect(world.upserts).toEqual([
      {
        orgId: "org-abc",
        stripeCustomerId: "cus_fresh_001",
        previousValue: "cus_stale_001",
      },
    ]);
    expect(world.settings?.stripeCustomerId).toBe("cus_fresh_001");
  });

  it("replaces a stale settings id with a live subscription id instead of keeping it", async () => {
    world.settings = { orgId: "org-abc", stripeCustomerId: "cus_stale_001" };
    world.subscription = { stripeCustomerId: "cus_live_001" };
    customerExistsMock.mockImplementation(async (id: string) => {
      return id !== "cus_stale_001";
    });

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_live_001");
    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(world.upserts).toEqual([
      {
        orgId: "org-abc",
        stripeCustomerId: "cus_live_001",
        previousValue: "cus_stale_001",
      },
    ]);
    expect(world.settings?.stripeCustomerId).toBe("cus_live_001");
  });

  it("a concurrent replacement of the same stale id resolves to one winner, not a split customer", async () => {
    world.settings = { orgId: "org-abc", stripeCustomerId: "cus_stale_001" };
    customerExistsMock.mockImplementation(async (id: string) => {
      return id !== "cus_stale_001";
    });
    findCustomerByOrgIdMock.mockResolvedValue(null);
    createCustomerMock.mockResolvedValue("cus_mine_001");
    world.beforeUpsert = () => {
      // A concurrent request already replaced the same stale id with a
      // different fresh customer before this call's upsert runs.
      world.settings = {
        orgId: "org-abc",
        stripeCustomerId: "cus_theirs_001",
      };
    };

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_theirs_001");
    expect(world.settings?.stripeCustomerId).toBe("cus_theirs_001");
  });

  it("falls through to create when metadata search returns a missing customer", async () => {
    findCustomerByOrgIdMock.mockResolvedValue({ id: "cus_ghost_001" });
    customerExistsMock.mockImplementation(async (id: string) => {
      return id !== "cus_ghost_001";
    });
    createCustomerMock.mockResolvedValue("cus_fresh_002");

    const result = await ensureStripeCustomer("org-abc");

    expect(result).toBe("cus_fresh_002");
    expect(createCustomerMock).toHaveBeenCalledOnce();
  });
});
