/**
 * Unit tests for prepaid-orders.ts: the order's validation and invoice lines,
 * the draft row, the invoice sequence and its resume, the grant and its
 * fences, and the void and uncollectible mirror.
 *
 * `billing.prepaid_orders` lives in an in-memory store behind a fake
 * executor that evaluates the `eq` / `and` / `isNull` conditions the module
 * builds (the drizzle operators are the plain objects of
 * test-utils/gau-conditions.ts), so a predicate the module gets wrong updates
 * the wrong row here too. The bucket upsert, the credit lot and the cap write
 * are module doubles whose own behaviour is tested beside them
 * (gau-bucket.test.ts, grants.test.ts, billing-settings.test.ts); what is
 * asserted here is that each is called once, with the order's figures, and
 * never on a second delivery. withTenantDb throws: nothing on these paths may
 * reach for a tenant scope, because neither the operator script nor the
 * webhook has one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cond } from "./test-utils/gau-conditions";
import type {
  AssistantSpendCapChange,
  BillingPrepaidInvoiceInput,
  BillingPrepaidInvoiceRef,
  BillingPrepaidInvoiceState,
} from "./provider";

const mocks = vi.hoisted(() => ({
  createPrepaidInvoice: vi.fn(),
  sendPrepaidInvoice: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  readGauEntitlement: vi.fn(),
  ensureCurrentBucket: vi.fn(),
  grantCreditLotOnce: vi.fn(),
  writeAssistantSpendCapOn: vi.fn(),
  emitSecurityEventAsync: vi.fn(),
  tx: null as unknown,
  events: [] as string[],
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = async () => {
    throw new Error("No active tenant scope");
  };
  return {
    ...real,
    withTenantDb,
    withOrgDb: withTenantDb,
    withSystemDb: async (fn: (tx: unknown) => unknown) => {
      const out = await fn(mocks.tx);
      mocks.events.push("commit");
      return out;
    },
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

vi.mock("./client", () => ({
  billingProvider: () => ({
    createPrepaidInvoice: mocks.createPrepaidInvoice,
    sendPrepaidInvoice: mocks.sendPrepaidInvoice,
  }),
}));

vi.mock(
  "./customers",
  () =>
    ({ ensureStripeCustomer: mocks.ensureStripeCustomer }) satisfies Pick<
      typeof import("./customers"),
      "ensureStripeCustomer"
    >,
);

vi.mock(
  "./contract-terms",
  () =>
    ({ readGauEntitlement: mocks.readGauEntitlement }) satisfies Pick<
      typeof import("./contract-terms"),
      "readGauEntitlement"
    >,
);

vi.mock("./gau-bucket", async (importOriginal) => {
  const real = await importOriginal<typeof import("./gau-bucket")>();
  return { ...real, ensureCurrentBucket: mocks.ensureCurrentBucket };
});

vi.mock(
  "./grants",
  () =>
    ({ grantCreditLotOnce: mocks.grantCreditLotOnce }) satisfies Pick<
      typeof import("./grants"),
      "grantCreditLotOnce"
    >,
);

vi.mock(
  "./billing-settings",
  () =>
    ({
      writeAssistantSpendCapOn: mocks.writeAssistantSpendCapOn,
    }) satisfies Pick<
      typeof import("./billing-settings"),
      "writeAssistantSpendCapOn"
    >,
);

const { getTableColumns } = await import("drizzle-orm");
const { schema } = await import("@oxagen/database");
const {
  assertPrepaidOrder,
  closePrepaidOrder,
  grantPrepaidOrder,
  invoicePrepaidOrder,
  openPrepaidOrder,
  prepaidOrderFigures,
  prepaidOrderLines,
  prepaidOrderTotalCents,
  PrepaidOrderError,
  readPrepaidOrderDefaults,
  resolvePrepaidOrderSpec,
  PREPAID_INVOICE_FOOTER,
} = await import("./prepaid-orders");
const { logger } = await import("./logger");
type PrepaidOrderSpec = import("./prepaid-orders").PrepaidOrderSpec;

// ── The in-memory prepaid_orders table ──────────────────────────────────────

type Row = Record<string, unknown>;

const COLUMN_KEY = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.prepaidOrders)).map(([k, c]) => [c, k]),
);

function keyOf(col: unknown): string {
  const key = COLUMN_KEY.get(col);
  if (key === undefined)
    throw new Error("fake tx: not a prepaid_orders column");
  return key;
}

function matches(row: Row, cond: Cond): boolean {
  switch (cond.op) {
    case "and":
      return cond.conds.every((c) => matches(row, c));
    case "isNull":
      return row[keyOf(cond.col)] === null;
    case "eq":
      return row[keyOf(cond.col)] === cond.val;
    default:
      throw new Error(`fake tx: unmodelled condition ${cond.op}`);
  }
}

let orders: Row[];

function makeTx() {
  const table = (t: unknown) => {
    if (t !== schema.prepaidOrders)
      throw new Error("fake tx: unexpected table");
  };
  return {
    execute: async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q.queryChunks ?? q);
      if (!text.includes("pg_advisory_xact_lock")) {
        throw new Error(`fake tx: unmodelled execute ${text}`);
      }
      mocks.events.push("lock");
    },
    select: () => ({
      from: (t: unknown) => {
        table(t);
        let rows = orders;
        const chain = {
          where: (cond: Cond) => {
            rows = rows.filter((r) => matches(r, cond));
            return chain;
          },
          limit: async (n: number) => rows.slice(0, n).map((r) => ({ ...r })),
        };
        return chain;
      },
    }),
    insert: (t: unknown) => {
      table(t);
      return {
        values: (v: Row) => ({
          onConflictDoNothing: (arg: { target: unknown }) => {
            expect(arg.target).toBe(schema.prepaidOrders.id);
            return {
              returning: async () => {
                if (orders.some((r) => r.id === v.id)) return [];
                const row: Row = {
                  stripeInvoiceId: null,
                  grantedBucketId: null,
                  unitsGrantedAt: null,
                  creditsGrantedAt: null,
                  paidAt: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  ...v,
                };
                orders.push(row);
                mocks.events.push("insert");
                return [{ ...row }];
              },
            };
          },
        }),
      };
    },
    update: (t: unknown) => {
      table(t);
      return {
        set: (patch: Row) => ({
          where: (cond: Cond) => {
            const hit = orders.filter((r) => matches(r, cond));
            for (const r of hit) Object.assign(r, patch);
            if (hit.length > 0)
              mocks.events.push(`update:${Object.keys(patch).join(",")}`);
            const done = Promise.resolve(undefined);
            return Object.assign(done, {
              returning: async () => hit.map((r) => ({ ...r })),
            });
          },
        }),
      };
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG = "0192d4a8-7c1e-7a00-8000-00000000e001";
const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const UNCHANGED: AssistantSpendCapChange = { kind: "unchanged" };

/** The lead's worked example: a year's licence, 2M units, $5,000 of credits. */
function spec(over: Partial<PrepaidOrderSpec> = {}): PrepaidOrderSpec {
  return {
    orgId: ORG,
    agreementRef: "MSA-2026-014",
    poNumber: "PO-7781",
    currency: "usd",
    licence: {
      amountCents: 12_000_000,
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2027-10-01T00:00:00.000Z"),
    },
    gau: { quantity: 2_000_000, ratePerGauMicros: 3_000n },
    creditCents: 500_000,
    daysUntilDue: 30,
    grantOn: "paid",
    memo: null,
    assistantSpendCap: UNCHANGED,
    ...over,
  };
}

const order = (id = ORDER) => orders.find((r) => r.id === id)!;

function sent(
  over: Partial<BillingPrepaidInvoiceState> = {},
): BillingPrepaidInvoiceState {
  return {
    status: "open",
    number: "OXA-0042",
    hostedInvoiceUrl: "https://invoice.stripe.com/i/pre",
    invoicePdfUrl: "https://invoice.stripe.com/i/pre.pdf",
    amountDueCents: 18_500_000,
    assistantSpendCap: UNCHANGED,
    ...over,
  };
}

async function issued(over: Partial<PrepaidOrderSpec> = {}) {
  await openPrepaidOrder({
    id: ORDER,
    spec: spec(over),
    issuedByRequestId: "req-1",
  });
  return invoicePrepaidOrder(ORDER, {
    assistantSpendCap: over.assistantSpendCap ?? UNCHANGED,
    now: NOW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orders = [];
  mocks.events = [];
  mocks.tx = makeTx();
  mocks.ensureStripeCustomer.mockResolvedValue("cus_ent_001");
  mocks.createPrepaidInvoice.mockImplementation(
    async (input: BillingPrepaidInvoiceInput) => {
      mocks.events.push(`create:${input.orderId}`);
      return { invoiceId: "in_pre_001" };
    },
  );
  mocks.sendPrepaidInvoice.mockImplementation(
    async (ref: BillingPrepaidInvoiceRef) => {
      mocks.events.push(`send:${ref.invoiceId}`);
      return sent();
    },
  );
  mocks.readGauEntitlement.mockResolvedValue({
    terms: {
      source: "negotiated",
      tier: "enterprise",
      agreementRef: "MSA-2026-014",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      currency: "usd",
      ratePerGauMicros: 3_000n,
      blockSizeGau: 10_000,
      includedGauPerMonth: 0,
    },
    subscription: null,
  });
  mocks.ensureCurrentBucket.mockResolvedValue({ id: "bkt_sep" });
  const granted = new Set<string>();
  mocks.grantCreditLotOnce.mockImplementation(
    async (_tx: unknown, args: { reason: string; referenceId: string }) => {
      // The partial unique index on grant_% reasons, by reference.
      const key = `${args.reason}:${args.referenceId}`;
      if (granted.has(key)) return false;
      granted.add(key);
      return true;
    },
  );
  mocks.writeAssistantSpendCapOn.mockImplementation(
    async (_tx: unknown, _org: string, cap: number | null) => cap,
  );
  mocks.emitSecurityEventAsync.mockResolvedValue(undefined);
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("assertPrepaidOrder", () => {
  const reasonOf = (s: PrepaidOrderSpec): string | null => {
    try {
      assertPrepaidOrder(s);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(PrepaidOrderError);
      expect((err as InstanceType<typeof PrepaidOrderError>).code).toBe(
        "invalid_prepaid_order",
      );
      return (err as InstanceType<typeof PrepaidOrderError>).reason;
    }
  };

  it("accepts the worked example", () => {
    expect(reasonOf(spec())).toBeNull();
  });

  it("refuses units whose total is not a whole number of cents, the table's CHECK", () => {
    // 3 units at 3,333 micros = 9,999 micros: not a multiple of 10,000.
    expect(
      reasonOf(spec({ gau: { quantity: 3, ratePerGauMicros: 3_333n } })),
    ).toBe("gau_not_whole_cents");
    expect(
      reasonOf(spec({ gau: { quantity: 30_000, ratePerGauMicros: 3_333n } })),
    ).toBe(null);
  });

  it.each([
    [{ licence: null, gau: null, creditCents: 0 }, "empty_order"],
    [{ currency: "USD" }, "currency"],
    [{ daysUntilDue: 366 }, "days_until_due"],
    [{ daysUntilDue: 1.5 }, "days_until_due"],
    [{ creditCents: -1 }, "credit_amount"],
    [{ creditCents: 0.5 }, "credit_amount"],
    [{ gau: { quantity: 0, ratePerGauMicros: 3_000n } }, "gau_quantity"],
    [{ gau: { quantity: 10, ratePerGauMicros: -1n } }, "gau_rate"],
    [{ agreementRef: "" }, "header_field"],
    [{ poNumber: "x".repeat(141) }, "header_field"],
    [{ memo: "x".repeat(501) }, "memo"],
    [
      {
        licence: {
          amountCents: 100,
          periodStart: new Date("2027-01-01T00:00:00.000Z"),
          periodEnd: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
      "licence_period",
    ],
    [
      {
        licence: {
          amountCents: 0,
          periodStart: new Date("2026-01-01T00:00:00.000Z"),
          periodEnd: new Date("2027-01-01T00:00:00.000Z"),
        },
      },
      "licence_amount",
    ],
    [
      {
        creditCents: 0,
        assistantSpendCap: { kind: "set" as const, capCents: 100 },
      },
      "cap_without_credits",
    ],
    [
      { assistantSpendCap: { kind: "set" as const, capCents: -5 } },
      "assistant_cap",
    ],
  ] as const)("refuses invalid case %#", (over, reason) => {
    expect(reasonOf(spec(over as Partial<PrepaidOrderSpec>))).toBe(reason);
  });

  it("accepts a cap of none on an order with credits", () => {
    expect(
      reasonOf(spec({ assistantSpendCap: { kind: "set", capCents: null } })),
    ).toBeNull();
  });
});

// ── The lines ───────────────────────────────────────────────────────────────

describe("prepaidOrderLines", () => {
  const figures = (over: Partial<PrepaidOrderSpec> = {}) => {
    const s = spec(over);
    return {
      agreementRef: s.agreementRef,
      currency: s.currency,
      licenceCents: s.licence?.amountCents ?? 0,
      licencePeriodStart: s.licence?.periodStart ?? null,
      licencePeriodEnd: s.licence?.periodEnd ?? null,
      gauQuantity: s.gau?.quantity ?? 0,
      ratePerGauMicros: s.gau?.ratePerGauMicros ?? 0n,
      creditCents: s.creditCents,
    };
  };

  it("prints the licence with its agreement and period, the units at their per-1,000 price, and the credits in money and count", () => {
    expect(prepaidOrderLines(figures())).toEqual([
      {
        key: "licence",
        description:
          "Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027",
        quantity: 1,
        unitAmountDecimal: "12000000",
        amountCents: 12_000_000,
        period: {
          start: new Date("2026-10-01T00:00:00.000Z"),
          end: new Date("2027-10-01T00:00:00.000Z"),
        },
      },
      {
        key: "gau",
        description:
          "Governed action units, prepaid: 2,000,000 GAU at $3.00 per 1,000",
        quantity: 2_000_000,
        unitAmountDecimal: "0.3",
        amountCents: 600_000,
        period: null,
      },
      {
        key: "credits",
        description:
          "Usage credits for the in-app assistant, prepaid: $5,000.00 (500,000 credits)",
        quantity: 1,
        unitAmountDecimal: "500000",
        amountCents: 500_000,
        period: null,
      },
    ]);
    expect(prepaidOrderTotalCents(figures())).toBe(13_100_000);
  });

  it("leaves the agreement out of the licence line when the order names none, and prints a sub-cent rate exactly", () => {
    const lines = prepaidOrderLines(
      figures({
        agreementRef: null,
        gau: { quantity: 10_000, ratePerGauMicros: 12_345n },
      }),
    );
    expect(lines[0]!.description).toBe(
      "Oxagen platform licence: 1 Oct 2026 to 30 Sep 2027",
    );
    expect(lines[1]).toMatchObject({
      description:
        "Governed action units, prepaid: 10,000 GAU at $12.345 per 1,000",
      unitAmountDecimal: "1.2345",
      amountCents: 12_345,
    });
  });

  it("builds the same lines from an order as stated as from the stored row", () => {
    expect(prepaidOrderLines(prepaidOrderFigures(spec()))).toEqual(
      prepaidOrderLines(figures()),
    );
  });

  it("prints only the lines the order carries", () => {
    expect(
      prepaidOrderLines(figures({ licence: null, gau: null })).map(
        (l) => l.key,
      ),
    ).toEqual(["credits"]);
  });
});

// ── Defaults ────────────────────────────────────────────────────────────────

describe("readPrepaidOrderDefaults", () => {
  it("takes the currency, agreement and rate of a negotiated agreement, on the system executor", async () => {
    expect(await readPrepaidOrderDefaults(ORG, NOW)).toEqual({
      currency: "usd",
      agreementRef: "MSA-2026-014",
      ratePerGauMicros: 3_000n,
    });
    expect(mocks.readGauEntitlement).toHaveBeenCalledWith(mocks.tx, ORG, NOW);
  });

  it("supplies no rate and no agreement for an org on published terms", async () => {
    mocks.readGauEntitlement.mockResolvedValueOnce({
      terms: {
        source: "published_tier",
        tier: "scale",
        effectiveFrom: NOW,
        effectiveTo: null,
        currency: "usd",
        ratePerGauMicros: 5_000n,
        blockSizeGau: 5_000,
        includedGauPerMonth: 5_000,
      },
      subscription: null,
    });
    expect(await readPrepaidOrderDefaults(ORG, NOW)).toEqual({
      currency: "usd",
      agreementRef: null,
      ratePerGauMicros: null,
    });
  });
});

describe("resolvePrepaidOrderSpec", () => {
  const NEGOTIATED = {
    currency: "usd",
    agreementRef: "MSA-2026-014",
    ratePerGauMicros: 3_000n,
  };
  const PUBLISHED = {
    currency: "usd",
    agreementRef: null,
    ratePerGauMicros: null,
  };
  const req = { orgId: ORG, daysUntilDue: 30, grantOn: "paid" as const };

  it("fills the currency, agreement and rate from the negotiated terms", () => {
    expect(
      resolvePrepaidOrderSpec(
        { ...req, gau: { quantity: 10_000 }, creditsCents: 100 },
        NEGOTIATED,
      ),
    ).toEqual({
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      poNumber: null,
      currency: "usd",
      licence: null,
      gau: { quantity: 10_000, ratePerGauMicros: 3_000n },
      creditCents: 100,
      daysUntilDue: 30,
      grantOn: "paid",
      memo: null,
      assistantSpendCap: { kind: "unchanged" },
    });
  });

  it("keeps what the request states over the defaults, and turns a cap into an instruction", () => {
    const spec = resolvePrepaidOrderSpec(
      {
        ...req,
        agreementRef: "SOW-9",
        currency: "eur",
        gau: { quantity: 10, ratePerGauMicros: 2_000n },
        assistantSpendCapCents: null,
      },
      NEGOTIATED,
    );
    expect(spec).toMatchObject({
      agreementRef: "SOW-9",
      currency: "eur",
      gau: { quantity: 10, ratePerGauMicros: 2_000n },
      assistantSpendCap: { kind: "set", capCents: null },
    });
  });

  it("refuses units with no rate for an org on published terms", () => {
    expect(() =>
      resolvePrepaidOrderSpec({ ...req, gau: { quantity: 10 } }, PUBLISHED),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_prepaid_order",
        reason: "gau_rate_required",
      }),
    );
  });

  it("refuses the contracted rate for an order in another currency", () => {
    expect(() =>
      resolvePrepaidOrderSpec(
        { ...req, currency: "eur", gau: { quantity: 10 } },
        NEGOTIATED,
      ),
    ).toThrow(/contracted rate is in usd and the order is in eur/);
  });

  it("needs no rate for an order without units", () => {
    expect(
      resolvePrepaidOrderSpec({ ...req, creditsCents: 100 }, PUBLISHED).gau,
    ).toBeNull();
  });
});

// ── The draft row ───────────────────────────────────────────────────────────

describe("openPrepaidOrder", () => {
  it("writes the draft row with the order's figures before anything else", async () => {
    const out = await openPrepaidOrder({
      id: ORDER,
      spec: spec(),
      issuedByRequestId: "req-1",
    });

    expect(out.created).toBe(true);
    expect(order()).toMatchObject({
      id: ORDER,
      orgId: ORG,
      status: "draft",
      agreementRef: "MSA-2026-014",
      poNumber: "PO-7781",
      licenceCents: 12_000_000,
      gauQuantity: 2_000_000,
      ratePerGauMicros: 3_000n,
      creditCents: 500_000,
      grantOn: "paid",
      daysUntilDue: 30,
      issuedByRequestId: "req-1",
      stripeInvoiceId: null,
    });
  });

  it("finds the same order on a re-run and inserts nothing", async () => {
    await openPrepaidOrder({
      id: ORDER,
      spec: spec(),
      issuedByRequestId: "req-1",
    });
    const again = await openPrepaidOrder({
      id: ORDER,
      spec: spec(),
      issuedByRequestId: "req-2",
    });

    expect(again.created).toBe(false);
    expect(orders).toHaveLength(1);
    expect(order().issuedByRequestId).toBe("req-1");
  });

  it("refuses an order id that already names different lines", async () => {
    await openPrepaidOrder({
      id: ORDER,
      spec: spec(),
      issuedByRequestId: "req-1",
    });
    await expect(
      openPrepaidOrder({
        id: ORDER,
        spec: spec({ creditCents: 400_000 }),
        issuedByRequestId: "req-2",
      }),
    ).rejects.toMatchObject({
      code: "prepaid_order_conflict",
      reason: "order_id_reused",
    });
    expect(Number(order().creditCents)).toBe(500_000);
  });

  it("writes nothing for an invalid order", async () => {
    await expect(
      openPrepaidOrder({
        id: ORDER,
        spec: spec({ gau: { quantity: 3, ratePerGauMicros: 3_333n } }),
        issuedByRequestId: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_prepaid_order" });
    expect(orders).toEqual([]);
  });
});

// ── The invoice ─────────────────────────────────────────────────────────────

describe("invoicePrepaidOrder", () => {
  it("creates the invoice with its header fields, footer, lines and cap metadata, records the id, sends it, and marks the order open", async () => {
    const cap = { kind: "set" as const, capCents: 600_000 };
    const out = await issued({ memo: "Year one.", assistantSpendCap: cap });

    expect(mocks.createPrepaidInvoice).toHaveBeenCalledWith({
      customerId: "cus_ent_001",
      orgId: ORG,
      orderId: ORDER,
      currency: "usd",
      daysUntilDue: 30,
      lines: [
        expect.objectContaining({ key: "licence", quantity: 1 }),
        expect.objectContaining({ key: "gau", quantity: 2_000_000 }),
        expect.objectContaining({ key: "credits", quantity: 1 }),
      ],
      customFields: [
        { name: "Agreement", value: "MSA-2026-014" },
        { name: "PO number", value: "PO-7781" },
      ],
      memo: "Year one.",
      footer: PREPAID_INVOICE_FOOTER,
      metadata: { assistant_spend_cap_cents: "600000" },
    });
    // The provider line carries no amountCents: Stripe computes the amount.
    const lines = mocks.createPrepaidInvoice.mock.calls[0]![0].lines;
    expect(lines[0]).not.toHaveProperty("amountCents");
    expect(mocks.sendPrepaidInvoice).toHaveBeenCalledWith({
      orderId: ORDER,
      invoiceId: "in_pre_001",
      expectedSubtotalCents: 13_100_000,
    });
    expect(mocks.events).toEqual([
      "insert",
      "commit",
      "commit", // read the row
      `create:${ORDER}`,
      "update:stripeInvoiceId,updatedAt",
      "commit",
      "send:in_pre_001",
      "update:status,updatedAt",
      "commit",
      "commit", // read it back
    ]);
    expect(out.order).toMatchObject({
      status: "open",
      stripeInvoiceId: "in_pre_001",
    });
    expect(out.invoice.number).toBe("OXA-0042");
    // grant_on = 'paid': nothing is granted until invoice.paid.
    expect(out.grant).toBeNull();
    expect(mocks.ensureCurrentBucket).not.toHaveBeenCalled();
    expect(mocks.grantCreditLotOnce).not.toHaveBeenCalled();
  });

  it("writes no cap metadata and no header fields the order does not carry", async () => {
    await issued({ agreementRef: null, poNumber: null });
    const input = mocks.createPrepaidInvoice.mock.calls[0]![0];
    expect(input.customFields).toEqual([]);
    expect(input.metadata).toEqual({});
  });

  it("resumes an order whose invoice was created: no second invoice, the same send", async () => {
    mocks.sendPrepaidInvoice.mockRejectedValueOnce(
      new Error("stripe unreachable"),
    );
    await expect(issued()).rejects.toThrow("stripe unreachable");
    expect(order()).toMatchObject({
      status: "draft",
      stripeInvoiceId: "in_pre_001",
    });

    const out = await invoicePrepaidOrder(ORDER, {
      assistantSpendCap: UNCHANGED,
    });

    expect(mocks.createPrepaidInvoice).toHaveBeenCalledOnce();
    expect(mocks.sendPrepaidInvoice).toHaveBeenCalledTimes(2);
    expect(out.order.status).toBe("open");
  });

  it("resumes an order whose create failed: the row holds no id, and the re-run creates it", async () => {
    mocks.createPrepaidInvoice.mockRejectedValueOnce(
      new Error("stripe unreachable"),
    );
    await expect(issued()).rejects.toThrow("stripe unreachable");
    expect(order()).toMatchObject({ status: "draft", stripeInvoiceId: null });

    await invoicePrepaidOrder(ORDER, { assistantSpendCap: UNCHANGED });

    expect(mocks.createPrepaidInvoice).toHaveBeenCalledTimes(2);
    expect(order()).toMatchObject({
      status: "open",
      stripeInvoiceId: "in_pre_001",
    });
  });

  it("re-running an open order only reads its invoice and changes nothing", async () => {
    await issued();
    mocks.events = [];

    const out = await invoicePrepaidOrder(ORDER, {
      assistantSpendCap: UNCHANGED,
    });

    expect(mocks.createPrepaidInvoice).toHaveBeenCalledOnce();
    expect(mocks.events.filter((e) => e.startsWith("update"))).toEqual([]);
    expect(out.order.status).toBe("open");
  });

  it("grants at issue for grant_on = 'issue', with the cap the invoice metadata carries, and leaves the order open", async () => {
    const cap = { kind: "set" as const, capCents: null };
    mocks.sendPrepaidInvoice.mockResolvedValueOnce(
      sent({ assistantSpendCap: cap }),
    );

    const out = await issued({ grantOn: "issue", assistantSpendCap: cap });

    expect(out.grant).toMatchObject({
      unitsGranted: 2_000_000,
      creditsGranted: 500_000,
      assistantSpendCapCents: null,
      status: "open",
    });
    expect(mocks.writeAssistantSpendCapOn).toHaveBeenCalledWith(
      mocks.tx,
      ORG,
      null,
    );
    expect(order()).toMatchObject({ status: "open", paidAt: null });
  });

  it("grants as paid when Stripe settles the invoice on send", async () => {
    mocks.sendPrepaidInvoice.mockResolvedValueOnce(sent({ status: "paid" }));

    const out = await issued();

    expect(out.grant).toMatchObject({
      status: "paid",
      creditsGranted: 500_000,
    });
    expect(order()).toMatchObject({ status: "paid", paidAt: NOW });
  });

  it.each(["void", "uncollectible"])(
    "refuses to invoice a %s order",
    async (status) => {
      await openPrepaidOrder({
        id: ORDER,
        spec: spec(),
        issuedByRequestId: null,
      });
      order().status = status;
      await expect(
        invoicePrepaidOrder(ORDER, { assistantSpendCap: UNCHANGED }),
      ).rejects.toMatchObject({ code: "prepaid_order_closed", reason: status });
      expect(mocks.createPrepaidInvoice).not.toHaveBeenCalled();
    },
  );

  it("refuses an order id with no row", async () => {
    await expect(
      invoicePrepaidOrder(ORDER, { assistantSpendCap: UNCHANGED }),
    ).rejects.toMatchObject({ code: "prepaid_order_not_found" });
  });
});

// ── The grant ───────────────────────────────────────────────────────────────

describe("grantPrepaidOrder", () => {
  const paid = (cap: AssistantSpendCapChange = UNCHANGED) =>
    grantPrepaidOrder(ORDER, {
      trigger: "paid",
      stripeInvoiceId: "in_pre_001",
      assistantSpendCap: cap,
      now: NOW,
    });

  it("takes the order's lock first, then adds the units to the current bucket and grants a never-expiring purchase lot referenced by the order", async () => {
    await issued();
    mocks.events = [];

    const out = await paid({ kind: "set", capCents: 600_000 });

    expect(mocks.events[0]).toBe("lock");
    expect(mocks.readGauEntitlement).toHaveBeenCalledWith(mocks.tx, ORG, NOW);
    expect(mocks.ensureCurrentBucket).toHaveBeenCalledWith(mocks.tx, ORG, {
      period: {
        start: new Date("2026-09-01T00:00:00.000Z"),
        end: new Date("2026-10-01T00:00:00.000Z"),
      },
      terms: expect.objectContaining({ agreementRef: "MSA-2026-014" }),
      usedDelta: 0,
      purchasedDelta: 2_000_000,
    });
    expect(mocks.grantCreditLotOnce).toHaveBeenCalledWith(mocks.tx, {
      orgId: ORG,
      reason: "grant_prepaid_invoice",
      referenceType: "prepaid_order",
      referenceId: ORDER,
      amountCents: 500_000n,
      source: "purchase",
      grantedAt: NOW,
      expiresAt: null,
    });
    expect(mocks.writeAssistantSpendCapOn).toHaveBeenCalledWith(
      mocks.tx,
      ORG,
      600_000,
    );
    expect(out).toEqual({
      orderId: ORDER,
      orgId: ORG,
      unitsGranted: 2_000_000,
      creditsGranted: 500_000,
      assistantSpendCapCents: 600_000,
      bucketId: "bkt_sep",
      status: "paid",
    });
    expect(order()).toMatchObject({
      status: "paid",
      paidAt: NOW,
      unitsGrantedAt: NOW,
      creditsGrantedAt: NOW,
      grantedBucketId: "bkt_sep",
    });
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledOnce();
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.credits_purchased",
        orgId: ORG,
      }),
    );
  });

  it("grants nothing on a second delivery of invoice.paid, and writes no second audit row", async () => {
    await issued();
    await paid({ kind: "set", capCents: 600_000 });
    vi.clearAllMocks();

    const again = await paid({ kind: "set", capCents: 600_000 });

    expect(again).toMatchObject({
      unitsGranted: 0,
      creditsGranted: 0,
      assistantSpendCapCents: undefined,
      bucketId: "bkt_sep",
      status: "paid",
    });
    expect(mocks.ensureCurrentBucket).not.toHaveBeenCalled();
    expect(mocks.grantCreditLotOnce).not.toHaveBeenCalled();
    expect(mocks.writeAssistantSpendCapOn).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("after an issue-time grant, payment only marks the order paid", async () => {
    await issued({ grantOn: "issue" });
    expect(mocks.grantCreditLotOnce).toHaveBeenCalledOnce();

    const out = await paid();

    expect(out).toMatchObject({
      unitsGranted: 0,
      creditsGranted: 0,
      status: "paid",
    });
    expect(mocks.ensureCurrentBucket).toHaveBeenCalledOnce();
    expect(mocks.grantCreditLotOnce).toHaveBeenCalledOnce();
    expect(order()).toMatchObject({ status: "paid", paidAt: NOW });
  });

  it("leaves the cap alone when the invoice carries no cap instruction", async () => {
    await issued();
    await paid(UNCHANGED);
    expect(mocks.writeAssistantSpendCapOn).not.toHaveBeenCalled();
  });

  it("grants no units and no credits for a licence-only order, and marks it paid", async () => {
    await issued({ gau: null, creditCents: 0 });
    const out = await paid();
    expect(out).toMatchObject({
      unitsGranted: 0,
      creditsGranted: 0,
      bucketId: null,
      status: "paid",
    });
    expect(mocks.ensureCurrentBucket).not.toHaveBeenCalled();
    expect(mocks.grantCreditLotOnce).not.toHaveBeenCalled();
  });

  it("grants nothing for a paid invoice that is not the one the order records", async () => {
    await issued();
    await expect(
      grantPrepaidOrder(ORDER, {
        trigger: "paid",
        stripeInvoiceId: "in_someone_else",
        assistantSpendCap: UNCHANGED,
      }),
    ).rejects.toMatchObject({
      code: "prepaid_order_conflict",
      reason: "foreign_invoice",
    });
    expect(mocks.ensureCurrentBucket).not.toHaveBeenCalled();
    expect(order().status).toBe("open");
  });

  it("refuses to pay a void order", async () => {
    await issued();
    order().status = "void";
    await expect(paid()).rejects.toMatchObject({
      code: "prepaid_order_closed",
      reason: "void",
    });
    expect(mocks.grantCreditLotOnce).not.toHaveBeenCalled();
  });

  it("grants an uncollectible order that is paid after all", async () => {
    await issued();
    order().status = "uncollectible";
    const out = await paid();
    expect(out).toMatchObject({ status: "paid", creditsGranted: 500_000 });
  });

  it("refuses an issue-time grant before the invoice is sent", async () => {
    await openPrepaidOrder({
      id: ORDER,
      spec: spec({ grantOn: "issue" }),
      issuedByRequestId: null,
    });
    await expect(
      grantPrepaidOrder(ORDER, {
        trigger: "issue",
        assistantSpendCap: UNCHANGED,
      }),
    ).rejects.toMatchObject({ code: "prepaid_order_closed", reason: "draft" });
  });

  it("keeps the grant when the audit row fails to write, and logs the failure", async () => {
    await issued();
    mocks.emitSecurityEventAsync.mockRejectedValueOnce(
      new Error("clickhouse down"),
    );
    const error = vi.spyOn(logger, "error");

    await expect(paid()).resolves.toMatchObject({ creditsGranted: 500_000 });

    expect(order().creditsGrantedAt).toEqual(NOW);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER, err: "clickhouse down" }),
      expect.stringMatching(/audit row failed/),
    );
  });
});

// ── Void and uncollectible ──────────────────────────────────────────────────

describe("closePrepaidOrder", () => {
  const close = (
    status: "void" | "uncollectible",
    stripeInvoiceId = "in_pre_001",
  ) => closePrepaidOrder(ORDER, { status, stripeInvoiceId });

  it.each(["void", "uncollectible"] as const)(
    "marks an open order %s under the order's lock",
    async (status) => {
      await issued();
      mocks.events = [];
      expect((await close(status)).status).toBe(status);
      expect(mocks.events[0]).toBe("lock");
      expect(order().status).toBe(status);
    },
  );

  it("records a void after an issue-time grant without reclaiming anything, and logs what stays granted", async () => {
    await issued({ grantOn: "issue" });
    const error = vi.spyOn(logger, "error");

    await close("void");

    expect(order()).toMatchObject({
      status: "void",
      unitsGrantedAt: NOW,
      creditsGrantedAt: NOW,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER,
        unitsGranted: 2_000_000,
        creditsGranted: 500_000,
      }),
      expect.stringMatching(/stay granted/),
    );
  });

  it("leaves a paid order paid", async () => {
    await issued();
    order().status = "paid";
    expect((await close("uncollectible")).status).toBe("paid");
  });

  it("is a no-op on a redelivery", async () => {
    await issued();
    await close("void");
    mocks.events = [];
    await close("void");
    expect(mocks.events.filter((e) => e.startsWith("update"))).toEqual([]);
  });

  it("refuses an invoice the order does not record", async () => {
    await issued();
    await expect(close("void", "in_other")).rejects.toMatchObject({
      code: "prepaid_order_conflict",
    });
    expect(order().status).toBe("open");
  });
});
