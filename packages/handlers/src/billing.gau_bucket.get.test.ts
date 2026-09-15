/**
 * Unit tests for the get_gau_bucket handler.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so the refusals below come from the handler alone. The
 * role gate runs for real against a tx double that answers the principal and
 * role-assignment tables.
 *
 * The read path is exercised three ways. Most tests inject the six reads, so
 * a test states a bucket and asserts what the page is told about it. The
 * settlement tests render `pastDueQuery` and `lastAutoTopupQuery` through
 * `drizzle.mock` and read the kind, status, order and limit off the SQL. One
 * test runs the shipped `postgresGauBucketQueries` — the real `readBucket`,
 * `readOrgBillingSettings` and `resolveGauEntitlement` from @oxagen/billing —
 * against a recording executor, and asserts that the statement log holds
 * SELECTs and nothing else: a read that created the month's bucket or the
 * settings row would race the recorder's lazy create (ARCHITECTURE.md §3.9
 * items 5, 6 and 9).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { isHandlerError } from "@oxagen/oxagen";
import { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import { schema } from "@oxagen/database";
import type {
  GauBucketView,
  GauEntitlement,
  GauTerms,
  OrgGauBillingSettings,
} from "@oxagen/billing";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import {
  createBillingGauBucketGetHandler,
  lastAutoTopupQuery,
  pastDueQuery,
  postgresGauBucketQueries,
  uninvoicedGau,
  type AutoTopupAttempt,
} from "./billing.gau_bucket.get";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const BUCKET = "0192d4a8-7c1e-7a00-8000-0000000b0c01";
const OTHER_ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3f";

const ctx = (over: { orgId?: string; userId?: string | null } = {}) =>
  makeCTX({ orgId: ORG, userId: USER, ...over });

// ── role-gate tx double ───────────────────────────────────────────────────────

/** Answers by the table asked for, so query order does not matter. */
function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

// ── terms, settings and bucket doubles ────────────────────────────────────────

const TERMS: GauTerms = {
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};

const SEPTEMBER = {
  start: new Date("2026-09-03T08:00:00.000Z"),
  end: new Date("2026-10-03T08:00:00.000Z"),
};

function entitlement(over: Partial<GauEntitlement> = {}): GauEntitlement {
  return {
    terms: {
      source: "published_tier",
      tier: "free",
      effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      effectiveTo: null,
      ...TERMS,
    },
    subscription: {
      billingInterval: "month",
      currentPeriodStart: SEPTEMBER.start,
      currentPeriodEnd: SEPTEMBER.end,
    },
    ...over,
  };
}

function settings(
  over: Partial<OrgGauBillingSettings> = {},
): OrgGauBillingSettings {
  return {
    orgId: ORG,
    stripeCustomerId: null,
    approvedForInvoiceBilling: false,
    invoiceGauMax: 100_000,
    autoTopupEnabled: true,
    autoTopupBlocks: 1,
    dunningState: "active",
    ...over,
  };
}

function bucketView(over: Partial<GauBucketView> = {}): GauBucketView {
  const base = {
    id: BUCKET as string | null,
    periodStart: SEPTEMBER.start,
    periodEnd: SEPTEMBER.end,
    includedGau: 5_000,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 0,
    overageInvoicedGau: 0,
    interimSeq: 0,
    topupSeq: 0,
    openTopupSettlementId: null,
    closedAt: null,
    ...over,
  };
  return {
    ...base,
    remainingGau:
      base.includedGau + base.purchasedGau + base.carriedGau - base.usedGau,
  };
}

type Deps = Parameters<typeof createBillingGauBucketGetHandler>[0];

function handlerWith(over: Partial<Deps> = {}) {
  const deps: Deps = {
    entitlement: () => Promise.resolve(entitlement()),
    settings: () => Promise.resolve(settings()),
    bucket: () => Promise.resolve(bucketView()),
    defaultPaymentMethod: () => Promise.resolve(null),
    pastDue: () => Promise.resolve(false),
    lastAutoTopup: () => Promise.resolve(null),
    ...over,
  };
  return createBillingGauBucketGetHandler(deps);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubRole("Owner");
});

// ── the role gate ─────────────────────────────────────────────────────────────

describe("get_gau_bucket role gate", () => {
  it.each(["Owner", "Admin", "Billing"])("admits %s", async (role) => {
    stubRole(role);
    const out = await handlerWith()({}, ctx());
    expect(out.mode).toBe("prepaid");
  });

  it("refuses a Member with forbidden", async () => {
    stubRole("Member");
    await expect(handlerWith()({}, ctx())).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.code === "forbidden",
    );
  });

  it("refuses a caller with no role assignment", async () => {
    stubRole(null);
    await expect(handlerWith()({}, ctx())).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.code === "forbidden",
    );
  });

  it("refuses an unauthenticated caller before reading anything", async () => {
    const bucket = vi.fn();
    await expect(
      handlerWith({ bucket })({}, ctx({ userId: null })),
    ).rejects.toSatisfy((e: unknown) => isHandlerError(e));
    expect(bucket).not.toHaveBeenCalled();
  });
});

// ── the counts ────────────────────────────────────────────────────────────────

describe("get_gau_bucket counts", () => {
  it("reports the terms' included figure, zero used and the previous month's carry for an org with no bucket row", async () => {
    // What readBucket answers with when no row exists: included from the
    // resolved terms, carried by the rollover formula, used zero.
    const out = await handlerWith({
      bucket: () =>
        Promise.resolve(
          bucketView({ id: null, includedGau: 5_000, carriedGau: 4_100 }),
        ),
    })({}, ctx());
    expect(out.includedGau).toBe(5_000);
    expect(out.usedGau).toBe(0);
    expect(out.carriedGau).toBe(4_100);
    expect(out.remainingGau).toBe(9_100);
  });

  it("reports remaining as included + purchased + carried − used", async () => {
    const out = await handlerWith({
      bucket: () =>
        Promise.resolve(
          bucketView({
            includedGau: 5_000,
            purchasedGau: 5_000,
            carriedGau: 250,
            usedGau: 900,
          }),
        ),
    })({}, ctx());
    expect(out.remainingGau).toBe(9_350);
  });

  it("reports a negative remaining when the org is overdrawn, never clamped to zero", async () => {
    const out = await handlerWith({
      bucket: () =>
        Promise.resolve(bucketView({ includedGau: 5_000, usedGau: 5_012 })),
    })({}, ctx());
    expect(out.remainingGau).toBe(-12);
  });

  it("reports the subscription's month, not the calendar year", async () => {
    const out = await handlerWith()({}, ctx());
    expect(out.period.start).toBe("2026-09-03T08:00:00.000Z");
    expect(out.period.end).toBe("2026-10-03T08:00:00.000Z");
    expect(out.period.start).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back to the UTC calendar month for an org with no subscription", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
    try {
      const out = await handlerWith({
        entitlement: () => Promise.resolve(entitlement({ subscription: null })),
      })({}, ctx());
      expect(out.period.start).toBe("2026-09-01T00:00:00.000Z");
      expect(out.period.end).toBe("2026-10-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── the mode ──────────────────────────────────────────────────────────────────

describe("get_gau_bucket mode", () => {
  it("takes the mode from the billing settings row", async () => {
    const out = await handlerWith({
      settings: () =>
        Promise.resolve(settings({ approvedForInvoiceBilling: true })),
    })({}, ctx());
    expect(out.mode).toBe("invoice");
  });

  it("does not report an unapproved org's invoice_gau_max whatever the stored value", async () => {
    const out = await handlerWith({
      settings: () =>
        Promise.resolve(
          settings({
            approvedForInvoiceBilling: false,
            invoiceGauMax: 250_000,
          }),
        ),
    })({}, ctx());
    expect(out.mode).toBe("prepaid");
    expect(out.invoice).toBeNull();
    expect(JSON.stringify(out)).not.toContain("250000");
  });

  it("reports the cap once an operator approves invoice billing", async () => {
    const out = await handlerWith({
      settings: () =>
        Promise.resolve(
          settings({ approvedForInvoiceBilling: true, invoiceGauMax: 250_000 }),
        ),
    })({}, ctx());
    expect(out.invoice?.gauMax).toBe(250_000);
    expect(out.autoTopup).toBeNull();
  });

  it("parses against the contract, so a prepaid org never carries an invoice block", async () => {
    const out = await handlerWith()({}, ctx());
    expect(billingGauBucketGet.output.parse(out)).toEqual(out);
  });
});

// ── invoice billing ───────────────────────────────────────────────────────────

describe("get_gau_bucket invoice thresholds", () => {
  const invoiced = (bucket: Partial<GauBucketView>, over: Partial<Deps> = {}) =>
    handlerWith({
      settings: () =>
        Promise.resolve(settings({ approvedForInvoiceBilling: true })),
      bucket: () => Promise.resolve(bucketView(bucket)),
      ...over,
    })({}, ctx());

  it("reports overage no settlement has claimed as uninvoiced", async () => {
    const out = await invoiced({
      includedGau: 300_000,
      usedGau: 412_000,
      overageInvoicedGau: 100_000,
    });
    expect(out.invoice?.uninvoicedGau).toBe(12_000);
    expect(out.invoice?.invoicedThisPeriodGau).toBe(100_000);
  });

  it("reports nothing uninvoiced while the org is inside its allowance", async () => {
    const out = await invoiced({ includedGau: 300_000, usedGau: 12 });
    expect(out.invoice?.uninvoicedGau).toBe(0);
  });

  it("counts purchased and carried units against the overage", async () => {
    const out = await invoiced({
      includedGau: 300_000,
      purchasedGau: 5_000,
      carriedGau: 1_000,
      usedGau: 310_000,
    });
    expect(out.invoice?.uninvoicedGau).toBe(4_000);
  });

  it("reports past due while an interim or period-close invoice is open", async () => {
    const out = await invoiced(
      { usedGau: 1 },
      { pastDue: () => Promise.resolve(true) },
    );
    expect(out.invoice?.pastDue).toBe(true);
  });

  it("reports not past due once that invoice is paid", async () => {
    const out = await invoiced(
      { usedGau: 1 },
      { pastDue: () => Promise.resolve(false) },
    );
    expect(out.invoice?.pastDue).toBe(false);
  });

  it("asks nothing of the settlement ledger for a month with no bucket row", async () => {
    const pastDue = vi.fn(() => Promise.resolve(true));
    const out = await invoiced({ id: null }, { pastDue });
    expect(pastDue).not.toHaveBeenCalled();
    expect(out.invoice?.pastDue).toBe(false);
  });
});

// ── auto top-up ───────────────────────────────────────────────────────────────

describe("get_gau_bucket auto top-up", () => {
  it("reports the toggle and the blocks per top-up as stored", async () => {
    const out = await handlerWith({
      settings: () =>
        Promise.resolve(
          settings({ autoTopupEnabled: false, autoTopupBlocks: 4 }),
        ),
    })({}, ctx());
    expect(out.autoTopup).toMatchObject({ enabled: false, blocks: 4 });
  });

  it("reports the org's default card as brand and last4", async () => {
    const out = await handlerWith({
      defaultPaymentMethod: () =>
        Promise.resolve({
          stripePaymentMethodId: "pm_1",
          brand: "visa",
          last4: "4242",
        }),
    })({}, ctx());
    expect(out.autoTopup?.paymentMethod).toEqual({
      brand: "visa",
      last4: "4242",
    });
    // The Stripe id is not the customer's business and never reaches the page.
    expect(JSON.stringify(out)).not.toContain("pm_1");
  });

  it("reports no payment method when the org has saved none", async () => {
    const out = await handlerWith()({}, ctx());
    expect(out.autoTopup?.paymentMethod).toBeNull();
  });

  it("reports the latest auto top-up episode of the period with its status", async () => {
    const attempt: AutoTopupAttempt = {
      at: new Date("2026-09-12T10:00:00.000Z"),
      status: "failed",
    };
    const out = await handlerWith({
      lastAutoTopup: () => Promise.resolve(attempt),
    })({}, ctx());
    expect(out.autoTopup?.lastAttempt).toEqual({
      at: "2026-09-12T10:00:00.000Z",
      status: "failed",
    });
  });

  it("asks nothing of the settlement ledger for a month with no bucket row", async () => {
    const lastAutoTopup = vi.fn(() => Promise.resolve(null));
    const out = await handlerWith({
      bucket: () => Promise.resolve(bucketView({ id: null })),
      lastAutoTopup,
    })({}, ctx());
    expect(lastAutoTopup).not.toHaveBeenCalled();
    expect(out.autoTopup?.lastAttempt).toBeNull();
  });
});

// ── the settlement queries ────────────────────────────────────────────────────

/**
 * The two predicates the page's `pastDue` and `lastAttempt` lines rest on,
 * read off the SQL the builders emit. The handler tests above inject the
 * answer; these fix what the ledger is asked.
 */
describe("get_gau_bucket settlement queries", () => {
  const db = drizzle.mock({ schema });

  describe("pastDueQuery", () => {
    it("asks for an open interim_invoice or period_close row of the org's bucket, one row at most", () => {
      const query = pastDueQuery(db, ORG, BUCKET).toSQL();
      expect(query.sql).toMatch(/"gau_settlements"\."org_id" = \$\d+/);
      expect(query.sql).toMatch(/"gau_settlements"\."bucket_id" = \$\d+/);
      expect(query.sql).toMatch(
        /"gau_settlements"\."kind" in \(\$\d+, \$\d+\)/,
      );
      expect(query.sql).toMatch(/"gau_settlements"\."status" = \$\d+/);
      expect(query.sql).toMatch(/limit \$\d+$/);
      expect(query.params).toEqual([
        ORG,
        BUCKET,
        "interim_invoice",
        "period_close",
        "open",
        1,
      ]);
    });

    it("counts neither a paid row nor an auto top-up (negative)", () => {
      const { params } = pastDueQuery(db, ORG, BUCKET).toSQL();
      expect(params).not.toContain("paid");
      expect(params).not.toContain("pending");
      expect(params).not.toContain("failed");
      expect(params).not.toContain("auto_topup");
      expect(params).not.toContain("checkout");
    });

    it("a different org binds a different id (negative)", () => {
      const { params } = pastDueQuery(db, OTHER_ORG, BUCKET).toSQL();
      expect(params).not.toContain(ORG);
      expect(params).toContain(OTHER_ORG);
    });
  });

  describe("lastAutoTopupQuery", () => {
    it("asks for the newest paid, open or failed auto_topup row of the org's bucket", () => {
      const query = lastAutoTopupQuery(db, ORG, BUCKET).toSQL();
      expect(query.sql).toMatch(/"gau_settlements"\."org_id" = \$\d+/);
      expect(query.sql).toMatch(/"gau_settlements"\."bucket_id" = \$\d+/);
      expect(query.sql).toMatch(/"gau_settlements"\."kind" = \$\d+/);
      expect(query.sql).toMatch(
        /"gau_settlements"\."status" in \(\$\d+, \$\d+, \$\d+\)/,
      );
      expect(query.sql).toMatch(
        /order by "billing"\."gau_settlements"\."created_at" desc, "billing"\."gau_settlements"\."id" desc limit \$\d+$/,
      );
      expect(query.params).toEqual([
        ORG,
        BUCKET,
        "auto_topup",
        "paid",
        "open",
        "failed",
        1,
      ]);
    });

    it("skips a pending row and every other kind (negative)", () => {
      const { params } = lastAutoTopupQuery(db, ORG, BUCKET).toSQL();
      expect(params).not.toContain("pending");
      expect(params).not.toContain("interim_invoice");
      expect(params).not.toContain("period_close");
      expect(params).not.toContain("checkout");
    });

    it("a different org binds a different id (negative)", () => {
      const { params } = lastAutoTopupQuery(db, OTHER_ORG, BUCKET).toSQL();
      expect(params).not.toContain(ORG);
      expect(params).toContain(OTHER_ORG);
    });
  });
});

// ── a read never writes ───────────────────────────────────────────────────────

/**
 * An executor that answers every SELECT with no rows and records the shape of
 * every statement. `insert`, `update` and `delete` record too, so a writer on
 * the read path shows up in the log rather than throwing something a test
 * could mistake for a different fault.
 */
function makeRecordingTx(log: string[]) {
  const empty = Promise.resolve([]);
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => empty,
    then: (resolve: (rows: unknown[]) => unknown) => empty.then(resolve),
  });
  const findFirst = () => Promise.resolve(undefined);
  return {
    select: () => {
      log.push("select");
      return chain;
    },
    insert: () => {
      log.push("insert");
      return chain;
    },
    update: () => {
      log.push("update");
      return chain;
    },
    delete: () => {
      log.push("delete");
      return chain;
    },
    query: new Proxy(
      {},
      {
        get: (_t, table: string) => ({
          findFirst: () => {
            log.push(`select:${table}`);
            return findFirst();
          },
        }),
      },
    ),
  };
}

describe("get_gau_bucket never writes", () => {
  it("issues SELECTs only — no INSERT on gau_buckets or org_billing_settings", async () => {
    const log: string[] = [];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn(makeRecordingTx(log))),
    );

    // The shipped queries: the real readBucket, readOrgBillingSettings,
    // resolveGauEntitlement and readDefaultPaymentMethod from @oxagen/billing.
    // resolveGauEntitlement throws for a database with no seeded Free plan,
    // which this executor is; the statement log is what the test is about.
    await Promise.allSettled([
      postgresGauBucketQueries.settings(ORG),
      postgresGauBucketQueries.entitlement(ORG, new Date()),
      postgresGauBucketQueries.bucket(ORG, {
        period: SEPTEMBER,
        terms: TERMS,
      }),
      postgresGauBucketQueries.defaultPaymentMethod(ORG),
      postgresGauBucketQueries.pastDue(ORG, BUCKET),
      postgresGauBucketQueries.lastAutoTopup(ORG, BUCKET),
    ]);

    // Every read is accounted for: the settings row and the default card by
    // name, the bucket, its previous month, the terms join and the two
    // settlement reads as plain selects.
    expect(log).toContain("select:orgBillingSettings");
    expect(log).toContain("select:paymentMethods");
    expect(log.filter((op) => op === "select").length).toBeGreaterThanOrEqual(
      5,
    );
    expect(
      log.filter((op) => op !== "select" && !op.startsWith("select:")),
    ).toEqual([]);
  });
});

// ── the uninvoiced formula ────────────────────────────────────────────────────

describe("uninvoicedGau", () => {
  it("is zero while consumption is inside the allowance", () => {
    expect(uninvoicedGau(bucketView({ includedGau: 100, usedGau: 40 }))).toBe(
      0,
    );
  });

  it("subtracts what interim and period-close settlements already claimed", () => {
    expect(
      uninvoicedGau(
        bucketView({
          includedGau: 100,
          usedGau: 350,
          overageInvoicedGau: 200,
        }),
      ),
    ).toBe(50);
  });

  it("floors at zero when a settlement claimed more than the current overage", () => {
    // Possible after a grant lands between the claim and this read: purchased
    // units move the overage down while overage_invoiced_gau stays put.
    expect(
      uninvoicedGau(
        bucketView({
          includedGau: 100,
          purchasedGau: 300,
          usedGau: 350,
          overageInvoicedGau: 200,
        }),
      ),
    ).toBe(0);
  });
});
