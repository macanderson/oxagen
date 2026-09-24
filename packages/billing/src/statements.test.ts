/**
 * statements.ts — period resolution, the statement reference, the day list,
 * the line-item cursor, and the assembly arithmetic over fixed reads.
 *
 * The Postgres reads (statement-reads.ts) are exercised against a migrated
 * database in statements.pg.test.ts; here the reads are a fixture, so every
 * figure below is checked against numbers written by hand.
 */
import { describe, expect, it } from "vitest";
import { billingStatementSchema } from "@oxagen/oxagen/contracts/billing.statement.get";
import type { GauEntitlement } from "./contract-terms";
import {
  assembleBillingStatement,
  decodeLineItemCursor,
  encodeLineItemCursor,
  lastDayOf,
  resolveStatementPeriod,
  StatementPeriodError,
  type StatementReads,
  statementDays,
  statementReference,
} from "./statements";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const ORG = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

function reasonOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof StatementPeriodError ? err.reason : "other";
  }
}

describe("resolveStatementPeriod", () => {
  it("resolves the Monday-to-Sunday UTC week containing the anchor", () => {
    // 2026-09-17 is a Thursday.
    const p = resolveStatementPeriod(
      { kind: "week", anchor: "2026-09-17" },
      NOW,
    );
    expect(p.start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(p.label).toBe("Week of 14 Sep 2026");
    // A Sunday belongs to the week that started six days before it.
    const sunday = resolveStatementPeriod(
      { kind: "week", anchor: "2026-09-20" },
      NOW,
    );
    expect(sunday.start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    // A Monday starts its own week.
    const monday = resolveStatementPeriod(
      { kind: "week", anchor: "2026-09-21" },
      NOW,
    );
    expect(monday.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("resolves the month, quarter and year containing the anchor", () => {
    const m = resolveStatementPeriod(
      { kind: "month", anchor: "2026-02-14" },
      NOW,
    );
    expect([m.start.toISOString(), m.end.toISOString(), m.label]).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "February 2026",
    ]);
    const q = resolveStatementPeriod(
      { kind: "quarter", anchor: "2026-09-01" },
      NOW,
    );
    expect([q.start.toISOString(), q.end.toISOString(), q.label]).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "Q3 2026",
    ]);
    const q4 = resolveStatementPeriod(
      { kind: "quarter", anchor: "2025-12-31" },
      NOW,
    );
    expect([q4.start.toISOString(), q4.end.toISOString(), q4.label]).toEqual([
      "2025-10-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "Q4 2025",
    ]);
    const y = resolveStatementPeriod(
      { kind: "year", anchor: "2025-06-30" },
      NOW,
    );
    expect([y.start.toISOString(), y.end.toISOString(), y.label]).toEqual([
      "2025-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2025",
    ]);
  });

  it("resolves a custom range, half-open, labelled by its last whole day", () => {
    const p = resolveStatementPeriod(
      {
        kind: "custom",
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-10T00:00:00Z",
      },
      NOW,
    );
    expect(p.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(p.label).toBe("1 Sep 2026 to 9 Sep 2026");
  });

  it("labels an off-midnight custom range with its times", () => {
    const p = resolveStatementPeriod(
      {
        kind: "custom",
        from: "2026-09-01T14:30:00+02:00",
        to: "2026-09-05T09:00:00Z",
      },
      NOW,
    );
    expect(p.start.toISOString()).toBe("2026-09-01T12:30:00.000Z");
    expect(p.label).toBe("1 Sep 2026 12:30 UTC to 5 Sep 2026 09:00 UTC");
  });

  it("requires a custom range strictly longer than 48 hours", () => {
    const at48 = {
      kind: "custom" as const,
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-03T00:00:00Z",
    };
    expect(reasonOf(() => resolveStatementPeriod(at48, NOW))).toBe(
      "range_too_short",
    );
    const justOver = { ...at48, to: "2026-09-03T00:00:00.001Z" };
    expect(reasonOf(() => resolveStatementPeriod(justOver, NOW))).toBeNull();
    const backwards = { ...at48, from: "2026-09-05T00:00:00Z" };
    expect(reasonOf(() => resolveStatementPeriod(backwards, NOW))).toBe(
      "range_too_short",
    );
  });

  it("allows a custom range of exactly 366 days and refuses one millisecond more", () => {
    const from = "2025-01-01T00:00:00.000Z";
    const exact = new Date(Date.parse(from) + 366 * 86_400_000).toISOString();
    expect(
      reasonOf(() =>
        resolveStatementPeriod({ kind: "custom", from, to: exact }, NOW),
      ),
    ).toBeNull();
    const over = new Date(Date.parse(exact) + 1).toISOString();
    expect(
      reasonOf(() =>
        resolveStatementPeriod({ kind: "custom", from, to: over }, NOW),
      ),
    ).toBe("range_too_long");
  });

  it("names the rule each refusal breaks", () => {
    const cases: [Parameters<typeof resolveStatementPeriod>[0], string][] = [
      [{ kind: "month" }, "anchor_required"],
      [{ kind: "month", anchor: "2026-02-30" }, "anchor_invalid"],
      [{ kind: "month", anchor: "2026-9-1" }, "anchor_invalid"],
      [
        { kind: "month", anchor: "2026-09-01", from: "2026-09-01T00:00:00Z" },
        "unexpected_field",
      ],
      [{ kind: "custom", anchor: "2026-09-01" }, "unexpected_field"],
      [{ kind: "custom", from: "2026-09-01T00:00:00Z" }, "range_required"],
      [
        { kind: "custom", from: "yesterday", to: "2026-09-10T00:00:00Z" },
        "range_invalid",
      ],
      [
        { kind: "custom", from: "2026-09-01T00:00:00Z", to: "soon" },
        "range_invalid",
      ],
      [{ kind: "year", anchor: "2027-01-01" }, "period_not_started"],
      [
        {
          kind: "custom",
          from: "2026-09-24T00:00:00Z",
          to: "2026-09-30T00:00:00Z",
        },
        "period_not_started",
      ],
    ];
    for (const [input, reason] of cases)
      expect(
        reasonOf(() => resolveStatementPeriod(input, NOW)),
        JSON.stringify(input),
      ).toBe(reason);
  });

  it("allows the period now falls in", () => {
    const p = resolveStatementPeriod(
      { kind: "month", anchor: "2026-09-23" },
      NOW,
    );
    expect(p.end.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("statementReference", () => {
  it("is deterministic and names the org, the start and the last day", () => {
    const p = resolveStatementPeriod(
      { kind: "month", anchor: "2026-09-01" },
      NOW,
    );
    expect(statementReference(ORG, p)).toBe("ST-0192F3A4-20260901-20260930");
    expect(statementReference(ORG, p)).toBe(statementReference(ORG, { ...p }));
  });

  it("carries the time for an off-midnight bound", () => {
    const p = resolveStatementPeriod(
      {
        kind: "custom",
        from: "2026-09-01T12:30:00Z",
        to: "2026-09-05T09:00:00Z",
      },
      NOW,
    );
    expect(statementReference(ORG, p)).toBe(
      "ST-0192F3A4-20260901T123000Z-20260905T090000Z",
    );
  });
});

describe("statementDays and lastDayOf", () => {
  it("lists every UTC day a period touches, partial days included", () => {
    expect(
      statementDays({
        start: new Date("2026-09-01T12:00:00Z"),
        end: new Date("2026-09-04T06:00:00Z"),
      }),
    ).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(
      statementDays({
        start: new Date("2026-09-01T00:00:00Z"),
        end: new Date("2026-09-04T00:00:00Z"),
      }),
    ).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(lastDayOf(new Date("2026-10-01T00:00:00Z"))).toBe("2026-09-30");
  });

  it("lists 366 days for a leap year", () => {
    const y = resolveStatementPeriod(
      { kind: "year", anchor: "2024-05-01" },
      NOW,
    );
    expect(statementDays(y)).toHaveLength(366);
  });
});

describe("line-item cursor", () => {
  const period = {
    start: new Date("2026-09-01T00:00:00Z"),
    end: new Date("2026-10-01T00:00:00Z"),
  };
  const at = {
    billedAt: "2026-09-02T10:11:12.123456Z",
    id: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
  };

  it("round-trips for the period it was written for", () => {
    expect(
      decodeLineItemCursor(encodeLineItemCursor(period, at), period),
    ).toEqual(at);
  });

  it("refuses the cursor of another period, and anything it did not write", () => {
    const other = { ...period, end: new Date("2026-09-30T00:00:00Z") };
    expect(
      decodeLineItemCursor(encodeLineItemCursor(period, at), other),
    ).toBeNull();
    expect(decodeLineItemCursor("not a cursor", period)).toBeNull();
    const tampered = Buffer.from(
      JSON.stringify([
        "st1",
        period.start.toISOString(),
        period.end.toISOString(),
        "2026-09-02",
        at.id,
      ]),
    ).toString("base64url");
    expect(decodeLineItemCursor(tampered, period)).toBeNull();
    const badId = encodeLineItemCursor(period, { ...at, id: "1; drop table" });
    expect(decodeLineItemCursor(badId, period)).toBeNull();
  });
});

// ── Assembly ────────────────────────────────────────────────────────────────

const ENTITLEMENT: GauEntitlement = {
  terms: {
    source: "negotiated",
    tier: "enterprise",
    agreementRef: "MSA-2026-014",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    currency: "usd",
    ratePerGauMicros: 4_500n,
    blockSizeGau: 10_000,
    includedGauPerMonth: 50_000,
  },
  subscription: null,
};

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

/** A consistent September: 12 units, 10 actions. */
function fixture(overrides: Partial<StatementReads> = {}): StatementReads {
  const calls: string[] = [];
  const reads: StatementReads = {
    org: async () => ({ id: ORG, name: "Acme <Corp>", slug: "acme" }),
    entitlement: async (_org, asOf) => {
      calls.push(`entitlement:${asOf.toISOString()}`);
      return ENTITLEMENT;
    },
    agreements: async () => [
      {
        agreementRef: "MSA-2026-014",
        currency: "usd",
        ratePerGauMicros: 4_500n,
        includedGauPerMonth: 50_000,
        blockSizeGau: 10_000,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: null,
      },
    ],
    ledgerBySource: async () => [
      { source: "kernel", units: 7, actions: 6 },
      { source: "tacho", units: 5, actions: 4 },
    ],
    ledgerBy: async (_o, _p, dimension, top) => {
      const all = {
        workspace: [
          { key: WS_A, units: 8, actions: 7 },
          { key: WS_B, units: 3, actions: 2 },
          { key: null, units: 1, actions: 1 },
        ],
        agent: [
          { key: "agt_alpha", units: 9, actions: 7 },
          { key: null, units: 3, actions: 3 },
        ],
        operator: [{ key: USER, units: 12, actions: 10 }],
      }[dimension];
      return { rows: all.slice(0, top), groups: all.length };
    },
    ledgerBySubject: async (_o, _p, top) => {
      const all = [
        {
          capability: "send_message",
          toolName: null,
          mcpServer: null,
          units: 7,
          actions: 6,
        },
        {
          capability: null,
          toolName: "Bash",
          mcpServer: null,
          units: 4,
          actions: 3,
        },
        {
          capability: null,
          toolName: "mcp__github__create_pr",
          mcpServer: "github",
          units: 1,
          actions: 1,
        },
      ];
      return { rows: all.slice(0, top), groups: all.length };
    },
    ledgerDaily: async () => [
      { date: "2026-09-02", units: 10, actions: 8 },
      { date: "2026-09-30", units: 2, actions: 2 },
    ],
    buckets: async () => [
      {
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        includedGau: 10,
        purchasedGau: 0,
        carriedGau: 0,
        usedGau: 12,
        overageInvoicedGau: 2,
        closedAt: null,
        ledgerUnits: 12,
        unitsInPeriod: 12,
      },
    ],
    settlements: async () => [
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "period_close",
        status: "open",
        quantityGau: 2,
        ratePerGauMicros: 4_500n,
        chargedCents: null,
        currency: "usd",
        createdAt: new Date("2026-09-30T23:00:00Z"),
        settledAt: null,
        invoice: {
          number: "OXG-0042",
          status: "open",
          hostedInvoiceUrl: "https://invoice.stripe.com/i/x",
        },
      },
    ],
    reversals: async () => [],
    prepaidOrders: async () => [
      {
        id: "55555555-5555-4555-8555-555555555555",
        status: "paid",
        agreementRef: "MSA-2026-014",
        poNumber: "PO-77",
        currency: "usd",
        licenceCents: 1_000_000,
        licencePeriodStart: new Date("2026-09-01T00:00:00Z"),
        licencePeriodEnd: new Date("2027-09-01T00:00:00Z"),
        gauQuantity: 100_000,
        ratePerGauMicros: 4_500n,
        creditCents: 50_000,
        createdAt: new Date("2026-09-01T09:00:00Z"),
        paidAt: new Date("2026-09-05T09:00:00Z"),
        invoice: null,
      },
    ],
    invoices: async () => [
      {
        publicId: "inv_a",
        number: "OXG-0041",
        status: "paid",
        settlementKind: null,
        prepaid: true,
        amountDueCents: 1_500_000,
        amountPaidCents: 1_500_000,
        amountRemainingCents: 0,
        currency: "usd",
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
        createdAt: new Date("2026-09-01T09:00:00Z"),
        dueAt: null,
        paidAt: new Date("2026-09-05T09:00:00Z"),
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
      },
      {
        publicId: "inv_b",
        number: "OXG-0042",
        status: "open",
        settlementKind: "period_close",
        prepaid: false,
        amountDueCents: 1,
        amountPaidCents: 0,
        amountRemainingCents: 1,
        currency: "usd",
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-09-30T23:00:00Z"),
        dueAt: new Date("2026-10-30T23:00:00Z"),
        paidAt: null,
        hostedInvoiceUrl: "https://invoice.stripe.com/i/x",
        invoicePdfUrl: null,
      },
      {
        publicId: "inv_c",
        number: "OXG-0040",
        status: "void",
        settlementKind: null,
        prepaid: false,
        amountDueCents: 999,
        amountPaidCents: 0,
        amountRemainingCents: 999,
        currency: "usd",
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        createdAt: new Date("2026-09-10T00:00:00Z"),
        dueAt: null,
        paidAt: null,
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
      },
    ],
    creditBalanceBefore: async (_o, at) =>
      at.toISOString().startsWith("2026-09-01") ? 1_000n : 51_000n - 400n + 0n,
    creditMovements: async () => ({
      additions: [
        { reason: "grant_prepaid_invoice", cents: 50_000n, entries: 1 },
      ],
      deductions: [
        { reason: "consume_assistant_tokens", cents: -300n, entries: 30 },
        { reason: "consume_embedding", cents: -100n, entries: 12 },
      ],
    }),
    assistantByOperator: async () => [
      { key: USER, cents: 250n, entries: 25 },
      { key: null, cents: 50n, entries: 5 },
    ],
    modelUsage: async () => [
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        calls: 40,
        inputTokens: 90_000,
        outputTokens: 8_000,
        costMicros: 420_000n,
        currency: "USD",
      },
      {
        provider: "openai",
        model: "gpt-5",
        calls: 5,
        inputTokens: 1_000,
        outputTokens: 200,
        costMicros: null,
        currency: "USD",
      },
    ],
    labels: async (_o, ids) => {
      calls.push(`labels:${JSON.stringify(ids)}`);
      return {
        workspaces: new Map([[WS_A, "Payments"]]),
        agents: new Map([["agt_alpha", "Release bot"]]),
        users: new Map([[USER, "Dana Ops"]]),
      };
    },
    ...overrides,
  };
  return Object.assign(reads, { calls });
}

const SEPTEMBER = resolveStatementPeriod(
  { kind: "month", anchor: "2026-09-01" },
  NOW,
);
const AFTER = new Date("2026-10-02T00:00:00Z");

describe("assembleBillingStatement", () => {
  it("matches the contract's output schema", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
    });
    expect(billingStatementSchema.safeParse(s).success).toBe(true);
  });

  it("totals the sources and zero-fills every day of the period", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
    });
    const ga = s.governedActions;
    expect([ga.totalUnits, ga.totalActions]).toEqual([12, 10]);
    expect(ga.bySource).toEqual([
      { source: "kernel", units: 7, actions: 6 },
      { source: "tacho", units: 5, actions: 4 },
      { source: "external_tool", units: 0, actions: 0 },
    ]);
    expect(ga.daily).toHaveLength(30);
    expect(ga.daily[0]).toEqual({ date: "2026-09-01", units: 0, actions: 0 });
    expect(ga.daily[1]).toEqual({ date: "2026-09-02", units: 10, actions: 8 });
    expect(ga.daily[29]).toEqual({ date: "2026-09-30", units: 2, actions: 2 });
  });

  it("labels the top groups, keeps raw ids, and folds the rest into other", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
      top: 1,
    });
    expect(s.governedActions.byWorkspace).toEqual({
      rows: [{ key: WS_A, label: "Payments", units: 8, actions: 7 }],
      other: { groups: 2, units: 4, actions: 3 },
    });
    expect(s.governedActions.bySubject.other).toEqual({
      groups: 2,
      units: 5,
      actions: 4,
    });
    const full = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
    });
    expect(full.governedActions.byWorkspace.rows.at(-1)).toEqual({
      key: null,
      label: null,
      units: 1,
      actions: 1,
    });
    // A workspace the store no longer names keeps its id and no label.
    expect(full.governedActions.byWorkspace.rows[1]).toEqual({
      key: WS_B,
      label: null,
      units: 3,
      actions: 2,
    });
    expect(full.governedActions.byWorkspace.other).toEqual({
      groups: 0,
      units: 0,
      actions: 0,
    });
  });

  it("asks for labels only for the ids it shows, and reads the terms at the period's last instant", async () => {
    const reads = fixture() as StatementReads & { calls: string[] };
    await assembleBillingStatement(reads, ORG, SEPTEMBER, {
      now: AFTER,
      top: 1,
    });
    expect(reads.calls).toContain("entitlement:2026-09-30T23:59:59.999Z");
    const labels = reads.calls.find((c) => c.startsWith("labels:"));
    expect(JSON.parse(labels?.slice(7) ?? "{}")).toEqual({
      workspaces: [WS_A],
      agents: ["agt_alpha"],
      users: [USER, USER],
    });
  });

  it("reads the terms now for a provisional statement", async () => {
    const reads = fixture() as StatementReads & { calls: string[] };
    const s = await assembleBillingStatement(reads, ORG, SEPTEMBER, {
      now: NOW,
    });
    expect(s.provisional).toBe(true);
    expect(reads.calls).toContain(`entitlement:${NOW.toISOString()}`);
    expect(s.terms.asOf).toBe(NOW.toISOString());
  });

  it("prices money records in micros and names each invoice's kind", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
    });
    expect(s.settlements[0]).toMatchObject({
      subtotalMicros: "9000",
      ratePerGauMicros: "4500",
      chargedMicros: null,
      invoice: { number: "OXG-0042", status: "open" },
    });
    expect(s.prepaidOrders[0]).toMatchObject({
      licenceMicros: "10000000000",
      gauMicros: "450000000",
      creditMicros: "500000000",
      totalMicros: "10950000000",
    });
    expect(s.invoices.map((i) => i.kind)).toEqual([
      "prepaid_order",
      "gau_period_close",
      "subscription",
    ]);
    // The void invoice is listed and left out of the totals.
    expect(s.invoiceTotals).toEqual([
      {
        currency: "usd",
        invoices: 2,
        dueMicros: "15000010000",
        paidMicros: "15000000000",
        remainingMicros: "10000",
      },
    ]);
  });

  it("rolls usage credits forward and breaks the assistant out by operator", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
    });
    expect(s.usageCredits).toEqual({
      openingCredits: "1000",
      additions: [
        { reason: "grant_prepaid_invoice", credits: "50000", entries: 1 },
      ],
      deductions: [
        { reason: "consume_assistant_tokens", credits: "300", entries: 30 },
        { reason: "consume_embedding", credits: "100", entries: 12 },
      ],
      closingCredits: "50600",
      assistantCredits: "300",
      assistantByOperator: [
        { key: USER, label: "Dana Ops", credits: "250", entries: 25 },
      ],
      assistantUnattributedCredits: "50",
    });
  });

  it("reports model usage and bills it at zero", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
      top: 1,
    });
    expect(s.modelUsage).toEqual({
      rows: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          calls: 40,
          inputTokens: 90_000,
          outputTokens: 8_000,
          reportedCostMicros: "420000",
          currency: "USD",
        },
      ],
      other: { groups: 1, calls: 5, inputTokens: 1_000, outputTokens: 200 },
      billedMicros: "0",
    });
  });

  it("holds every reconciliation check on consistent reads", async () => {
    const s = await assembleBillingStatement(fixture(), ORG, SEPTEMBER, {
      now: AFTER,
    });
    expect(s.reconciliation.map((c) => [c.id, c.holds])).toEqual([
      ["units_by_day", true],
      ["units_by_dimension", true],
      ["units_by_bucket", true],
      ["bucket_ledger", true],
      ["credits_roll_forward", true],
    ]);
    expect(s.buckets[0]).toMatchObject({
      remainingGau: -2,
      overageGau: 2,
      reconciliation: "matched",
    });
  });

  it("fails the check a broken read breaks", async () => {
    const s = await assembleBillingStatement(
      fixture({
        ledgerDaily: async () => [
          { date: "2026-09-02", units: 11, actions: 9 },
        ],
        buckets: async () => [
          {
            periodStart: new Date("2026-09-01T00:00:00Z"),
            periodEnd: new Date("2026-10-01T00:00:00Z"),
            includedGau: 10,
            purchasedGau: 0,
            carriedGau: 0,
            usedGau: 10,
            overageInvoicedGau: 0,
            closedAt: null,
            ledgerUnits: 12,
            unitsInPeriod: 12,
          },
        ],
        creditBalanceBefore: async (_o, at) =>
          at.toISOString().startsWith("2026-09-01") ? 1_000n : 1n,
      }),
      ORG,
      SEPTEMBER,
      { now: AFTER },
    );
    const failing = s.reconciliation.filter((c) => !c.holds).map((c) => c.id);
    expect(failing).toEqual([
      "units_by_day",
      "bucket_ledger",
      "credits_roll_forward",
    ]);
    expect(s.buckets[0]?.reconciliation).toBe("mismatch");
  });

  it("marks a bucket from before the ledger unitemised, which is not a failure", async () => {
    const s = await assembleBillingStatement(
      fixture({
        buckets: async () => [
          {
            periodStart: new Date("2026-09-01T00:00:00Z"),
            periodEnd: new Date("2026-10-01T00:00:00Z"),
            includedGau: 10,
            purchasedGau: 5,
            carriedGau: 1,
            usedGau: 20,
            overageInvoicedGau: 0,
            closedAt: new Date("2026-10-01T01:00:00Z"),
            ledgerUnits: 12,
            unitsInPeriod: 12,
          },
        ],
      }),
      ORG,
      SEPTEMBER,
      { now: AFTER },
    );
    expect(s.buckets[0]).toMatchObject({
      reconciliation: "unitemised",
      remainingGau: -4,
    });
    expect(s.reconciliation.find((c) => c.id === "bucket_ledger")?.holds).toBe(
      true,
    );
  });

  it("refuses a settlement kind outside the CHECK rather than guess an invoice kind", async () => {
    const base = fixture();
    const rows = await base.invoices(ORG, SEPTEMBER);
    await expect(
      assembleBillingStatement(
        fixture({
          invoices: async () => [{ ...rows[0]!, settlementKind: "refund" }],
        }),
        ORG,
        SEPTEMBER,
        { now: AFTER },
      ),
    ).rejects.toThrow(/outside the CHECK/);
  });

  it("refuses an organization it cannot find", async () => {
    await expect(
      assembleBillingStatement(
        fixture({ org: async () => null }),
        ORG,
        SEPTEMBER,
        { now: AFTER },
      ),
    ).rejects.toThrow(/no organization/);
  });
});
