/**
 * purchase_gau_bucket (WL-28, ADR-055 §6, apps/app/ARCHITECTURE.md §3.9).
 *
 * The handler runs against the real role gate, the real `resolveContractTerms`,
 * the real `readOrgBillingSettings` and the real `ensureStripeCustomer`; only
 * the database and the billing provider are faked. The fake database answers
 * by table for the organisation whose tenant scope is active, records every
 * table it is asked about and every row it is asked to write, and holds a
 * gau_buckets row for each org so a test can say what the bucket looked
 * like — and assert the handler never read it. Every organisation in the
 * fixture is tier `free`, the tier for which the kernel's IAM check allows
 * every capability, so a refusal can only come from the handler's own gate
 * (INV-29).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingProvider } from "@oxagen/billing";

// ── the world the fake database answers from ─────────────────────────────────

interface PlanRow {
  tier: string;
  currency: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  updatedAt: Date;
}

interface NegotiatedRow {
  agreementRef: string;
  currency: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

interface OrgWorld {
  /** The acting user's org role, or null for a user with none. */
  role: string | null;
  negotiated: NegotiatedRow | null;
  /** The entitled subscription joined to its plan, or null for none. */
  entitled: (PlanRow & { billingInterval: string }) | null;
  /** The subscriptions row's customer, or null for a subscription-less org. */
  subscriptionCustomerId: string | null;
  /** The org_billing_settings row, or null for an org with none yet. */
  settings: {
    stripeCustomerId: string | null;
    approvedForInvoiceBilling: boolean;
  } | null;
  /** Whether a default payment_methods row exists. Never read by the handler. */
  hasDefaultCard: boolean;
  /** The month's bucket. Never read by the handler. */
  bucket: { includedGau: number; usedGau: number };
}

/** The seeded Free plan row, at a rate no rate band ever quotes. */
const FREE_PLAN: PlanRow = {
  tier: "free",
  currency: "usd",
  ratePerGauMicros: 5_500n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const NEGOTIATED: NegotiatedRow = {
  agreementRef: "MSA-2026-017",
  currency: "usd",
  ratePerGauMicros: 7_500n,
  blockSizeGau: 10_000,
  includedGauPerMonth: 1_000_000,
  effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
  effectiveTo: null,
};

const { world, scope, log, key } = vi.hoisted(() => ({
  world: new Map<string, unknown>(),
  scope: { orgId: "" },
  /** The user the API key in these tests was created by, or none. */
  key: { creator: "usr_creator" as string | null },
  log: {
    tablesRead: [] as string[],
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  },
}));

const PRINCIPAL_ID = "prn_actor";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const here = () => {
    const w = world.get(scope.orgId) as OrgWorld | undefined;
    if (!w) throw new Error(`no tenant scope entered for ${scope.orgId}`);
    return w;
  };
  const nameOf = (table: unknown): string => {
    for (const [k, v] of Object.entries(real.schema)) if (v === table) return k;
    return "unknown";
  };
  const rowsFor = (table: unknown, joined: boolean): unknown[] => {
    const w = here();
    log.tablesRead.push(nameOf(table));
    if (table === real.schema.apiKeys)
      return key.creator ? [{ createdByUserId: key.creator }] : [];
    if (table === real.schema.principals) return [{ id: PRINCIPAL_ID }];
    if (table === real.schema.principalRoleAssignments)
      return w.role ? [{ roleName: w.role }] : [];
    if (table === real.schema.contractTerms)
      return w.negotiated ? [w.negotiated] : [];
    if (table === real.schema.subscriptions && joined)
      return w.entitled ? [w.entitled] : [];
    if (table === real.schema.plans) return [FREE_PLAN];
    if (table === real.schema.gauBuckets) return [w.bucket];
    throw new Error(`unexpected table ${nameOf(table)}`);
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        let joined = false;
        const chain = {
          innerJoin: () => {
            joined = true;
            return chain;
          },
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rowsFor(table, joined)),
        };
        return chain;
      },
    }),
    query: {
      orgBillingSettings: {
        findFirst: async () => {
          log.tablesRead.push("orgBillingSettings");
          const s = here().settings;
          return s
            ? {
                stripeCustomerId: s.stripeCustomerId,
                approvedForInvoiceBilling: s.approvedForInvoiceBilling,
                invoiceGauMax: 100_000,
                autoTopupEnabled: true,
                autoTopupBlocks: 1,
                dunningState: "active",
              }
            : undefined;
        },
      },
      organizations: {
        findFirst: async () => {
          log.tablesRead.push("organizations");
          return { id: scope.orgId, name: "Acme", slug: "acme" };
        },
      },
      subscriptions: {
        findFirst: async () => {
          log.tablesRead.push("subscriptions");
          const id = here().subscriptionCustomerId;
          return id ? { stripeCustomerId: id } : undefined;
        },
      },
      paymentMethods: {
        findFirst: async () => {
          log.tablesRead.push("paymentMethods");
          return here().hasDefaultCard
            ? { stripePaymentMethodId: "pm_1", brand: "visa", last4: "4242" }
            : undefined;
        },
      },
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const w = here();
            log.inserts.push({ table: nameOf(table), values });
            if (table !== real.schema.orgBillingSettings) {
              throw new Error(`unexpected insert into ${nameOf(table)}`);
            }
            const id = values.stripeCustomerId as string;
            w.settings = w.settings
              ? {
                  ...w.settings,
                  stripeCustomerId: w.settings.stripeCustomerId ?? id,
                }
              : { stripeCustomerId: id, approvedForInvoiceBilling: false };
            return [{ stripeCustomerId: w.settings.stripeCustomerId }];
          },
        }),
      }),
    }),
  };
  return {
    ...real,
    withTenantDb: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
});

const emitSecurityEvent = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent }));

import { isHandlerError } from "@oxagen/oxagen";
import { setBillingProvider, resetBillingProvider } from "@oxagen/billing";
import { billingGauBucketPurchaseHandler } from "./billing.gau_bucket.purchase";

// ── the fake provider ────────────────────────────────────────────────────────

const provider = {
  createGauCheckout: vi.fn(),
  findCustomerByOrgId: vi.fn(),
  createCustomer: vi.fn(),
};

// ── helpers ──────────────────────────────────────────────────────────────────

const ORG_FREE = "00000000-0000-0000-0000-00000000f0f1";
const ORG_NEGOTIATED = "00000000-0000-0000-0000-00000000e0e1";
const ORG_INVOICED = "00000000-0000-0000-0000-00000000d0d1";

const INPUT = {
  quantityGau: 10_000,
  successPath: "/acme/billing?checkout=success",
  cancelPath: "/acme/billing?checkout=cancel",
};

function ctxFor(
  orgId: string,
  userId: string | null = "usr_actor",
  apiKeyId: string | null = null,
) {
  return {
    orgId,
    workspaceId: "ws_1",
    userId,
    apiKeyId,
    requestId: "req_1",
    surface: "api" as const,
    messageId: null,
    executionStepId: null,
  };
}

/** Enter `orgId`'s tenant scope and run the purchase, as the kernel would. */
async function purchaseFor(
  orgId: string,
  input = INPUT,
  userId: string | null = "usr_actor",
  apiKeyId: string | null = null,
) {
  scope.orgId = orgId;
  return billingGauBucketPurchaseHandler(
    input,
    ctxFor(orgId, userId, apiKeyId),
  );
}

function orgWorld(overrides: Partial<OrgWorld> = {}): OrgWorld {
  return {
    role: "Owner",
    negotiated: null,
    entitled: null,
    subscriptionCustomerId: null,
    settings: null,
    hasDefaultCard: false,
    // Exhausted: remaining = 0.
    bucket: { includedGau: 5_000, usedGau: 5_000 },
    ...overrides,
  };
}

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

beforeEach(() => {
  vi.clearAllMocks();
  log.tablesRead.length = 0;
  log.inserts.length = 0;
  key.creator = "usr_creator";
  world.clear();
  world.set(ORG_FREE, orgWorld());
  world.set(ORG_NEGOTIATED, orgWorld({ negotiated: NEGOTIATED }));
  world.set(
    ORG_INVOICED,
    orgWorld({
      settings: {
        stripeCustomerId: "cus_inv",
        approvedForInvoiceBilling: true,
      },
    }),
  );
  provider.createGauCheckout.mockResolvedValue({
    sessionId: "cs_test_001",
    url: "https://checkout.stripe.com/c/pay/cs_test_001",
  });
  provider.findCustomerByOrgId.mockResolvedValue(null);
  provider.createCustomer.mockResolvedValue("cus_new_001");
  setBillingProvider(provider as unknown as BillingProvider);
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
});

afterEach(() => {
  resetBillingProvider();
  delete process.env.NEXT_PUBLIC_APP_URL;
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("purchase_gau_bucket handler", () => {
  it("a Free org with no payment method and remaining ≤ 0 creates a session for blocks × block price at the published rate", async () => {
    const out = await purchaseFor(ORG_FREE);

    expect(out).toEqual({
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_001",
      quantityGau: 10_000,
      blockSizeGau: 5_000,
      blocks: 2,
    });
    expect(provider.createGauCheckout).toHaveBeenCalledOnce();
    expect(provider.createGauCheckout).toHaveBeenCalledWith({
      customerId: "cus_new_001",
      orgId: ORG_FREE,
      quantityGau: 10_000,
      blocks: 2,
      // 5,500 micros × 5,000 GAU = 27,500,000 micros = 2,750 cents.
      blockPriceCents: 2_750,
      ratePerGauMicros: 5_500n,
      currency: "usd",
      successUrl: "https://app.test/acme/billing?checkout=success",
      cancelUrl: "https://app.test/acme/billing?checkout=cancel",
    });
    // No tier gate and no card check: the Checkout saves the card.
    expect(log.tablesRead).not.toContain("paymentMethods");
  });

  it("INV-27: a prepaid org at remaining = 0 is never refused, and the handler never reads the bucket", async () => {
    const w = world.get(ORG_FREE) as OrgWorld;
    w.bucket = { includedGau: 5_000, usedGau: 5_000 };

    await expect(purchaseFor(ORG_FREE)).resolves.toMatchObject({ blocks: 2 });
    expect(log.tablesRead).not.toContain("gauBuckets");
  });

  it("inserts no pending row: the only write is the org's customer id, which its first purchase creates", async () => {
    await purchaseFor(ORG_FREE);

    expect(log.inserts.map((i) => i.table)).toEqual(["orgBillingSettings"]);
    expect(log.inserts[0]!.values).toMatchObject({
      orgId: ORG_FREE,
      stripeCustomerId: "cus_new_001",
    });
    expect((world.get(ORG_FREE) as OrgWorld).settings?.stripeCustomerId).toBe(
      "cus_new_001",
    );
  });

  it("a second purchase reuses the customer the first one wrote", async () => {
    await purchaseFor(ORG_FREE);
    await purchaseFor(ORG_FREE);

    expect(provider.createCustomer).toHaveBeenCalledOnce();
    expect(provider.createGauCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({ customerId: "cus_new_001" }),
    );
  });

  it("recomputes blocks and the block price from the terms in force at submit time", async () => {
    const out = await purchaseFor(ORG_NEGOTIATED, {
      ...INPUT,
      quantityGau: 20_000,
    });

    expect(out).toMatchObject({
      quantityGau: 20_000,
      blockSizeGau: 10_000,
      blocks: 2,
    });
    expect(provider.createGauCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: 2,
        // 7,500 micros × 10,000 GAU = 7,500 cents.
        blockPriceCents: 7_500,
        ratePerGauMicros: 7_500n,
      }),
    );
  });

  it("refuses a quantity that is not a whole number of blocks as invalid_input, before any provider call", async () => {
    const err = await purchaseFor(ORG_FREE, {
      ...INPUT,
      quantityGau: 7_000,
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "invalid_input" });
    expect(provider.createGauCheckout).not.toHaveBeenCalled();
    expect(log.inserts).toEqual([]);
  });

  it("measures the block against the negotiated size, so a quantity valid for the published tier can be refused", async () => {
    const err = await purchaseFor(ORG_NEGOTIATED, {
      ...INPUT,
      quantityGau: 5_000,
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "invalid_input" });
    expect(provider.createGauCheckout).not.toHaveBeenCalled();
  });

  it("refuses an org approved for invoice billing with conflict / invoice_billed", async () => {
    const err = await purchaseFor(ORG_INVOICED).catch((e: unknown) => e);

    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({ code: "conflict", reason: "invoice_billed" });
    expect(provider.createGauCheckout).not.toHaveBeenCalled();
    expect(log.inserts).toEqual([]);
  });

  it("the Billing role may buy", async () => {
    (world.get(ORG_FREE) as OrgWorld).role = "Billing";
    await expect(purchaseFor(ORG_FREE)).resolves.toMatchObject({ blocks: 2 });
  });

  it.each(["Admin", "Member", "Viewer"])(
    "refuses %s on a tier-free org with HandlerError forbidden, before any read or write",
    async (role) => {
      (world.get(ORG_FREE) as OrgWorld).role = role;

      await expect(purchaseFor(ORG_FREE)).rejects.toSatisfy(forbidden);
      expect(provider.createGauCheckout).not.toHaveBeenCalled();
      expect(log.tablesRead).not.toContain("orgBillingSettings");
      expect(log.inserts).toEqual([]);
    },
  );

  it("refuses a caller with no user and no API key as forbidden", async () => {
    await expect(purchaseFor(ORG_FREE, INPUT, null)).rejects.toMatchObject({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(provider.createGauCheckout).not.toHaveBeenCalled();
  });

  describe("an API-key call acts as the key's creator", () => {
    const buyAsKey = () => purchaseFor(ORG_FREE, INPUT, null, "aky_1");

    it("buys for a creator who is an org Owner, and the security event names the creator", async () => {
      await expect(buyAsKey()).resolves.toMatchObject({ blocks: 2 });
      expect(emitSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: "usr_creator" }),
      );
    });

    it("refuses a key whose creator is an org Admin (negative)", async () => {
      (world.get(ORG_FREE) as OrgWorld).role = "Admin";
      await expect(buyAsKey()).rejects.toMatchObject({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(provider.createGauCheckout).not.toHaveBeenCalled();
    });

    it("refuses a key with no creator (negative)", async () => {
      key.creator = null;
      await expect(buyAsKey()).rejects.toMatchObject({
        code: "forbidden",
        reason: "no_principal",
      });
      expect(provider.createGauCheckout).not.toHaveBeenCalled();
    });
  });

  it("prefixes the return paths with NEXT_PUBLIC_APP_URL, whatever its trailing slash", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test/";

    await purchaseFor(ORG_FREE, {
      ...INPUT,
      successPath: "/",
      cancelPath: "/acme/billing",
    });

    expect(provider.createGauCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl: "https://app.test/",
        cancelUrl: "https://app.test/acme/billing",
      }),
    );
  });

  it("refuses to run without NEXT_PUBLIC_APP_URL rather than sending Checkout a bare path", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;

    await expect(purchaseFor(ORG_FREE)).rejects.toThrow("NEXT_PUBLIC_APP_URL");
    expect(provider.createGauCheckout).not.toHaveBeenCalled();
  });

  it("records the checkout as a security event under the capability's name", async () => {
    await purchaseFor(ORG_FREE);

    expect(emitSecurityEvent).toHaveBeenCalledOnce();
    expect(emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.checkout_initiated",
        capability: "purchase_gau_bucket",
        orgId: ORG_FREE,
        actorUserId: "usr_actor",
        outcome: "success",
      }),
    );
  });

  it("emits no security event when the provider refuses the session", async () => {
    provider.createGauCheckout.mockRejectedValue(new Error("stripe down"));

    await expect(purchaseFor(ORG_FREE)).rejects.toThrow("stripe down");
    expect(emitSecurityEvent).not.toHaveBeenCalled();
  });
});
