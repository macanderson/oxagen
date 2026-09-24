/**
 * statement-render.ts — the CSV and HTML forms of a statement: money
 * formatting, CSV quoting and formula neutralising, page concatenation, and
 * HTML escaping of every string a customer or an agent could have written.
 */
import { describe, expect, it } from "vitest";
import { STATEMENT_LINE_ITEM_COLUMNS } from "@oxagen/oxagen/contracts/billing.statement.export";
import type { BillingStatement } from "@oxagen/oxagen/contracts/billing.statement.get";
import {
  csvText,
  escapeHtml,
  formatCredits,
  formatMoney,
  formatRate,
  renderLineItemsCsv,
  renderStatementCsv,
  renderStatementHtml,
} from "./statement-render";
import type { StatementLineItem } from "./statements";

const HOSTILE = `<script>alert("x")</script>&'`;

function statement(
  overrides: Partial<BillingStatement> = {},
): BillingStatement {
  return {
    version: 1,
    reference: "ST-0192F3A4-20260901-20260930",
    generatedAt: "2026-10-02T00:00:00.000Z",
    provisional: false,
    org: {
      id: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
      name: `Acme ${HOSTILE}`,
      slug: "acme",
    },
    period: {
      kind: "month",
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
      lastDay: "2026-09-30",
      label: "September 2026",
    },
    terms: {
      source: "negotiated",
      tier: "enterprise",
      agreementRef: "MSA-2026-014",
      currency: "usd",
      ratePerGauMicros: "4500",
      blockSizeGau: 10_000,
      includedGauPerMonth: 50_000,
      asOf: "2026-09-30T23:59:59.999Z",
    },
    agreements: [],
    governedActions: {
      totalUnits: 12,
      totalActions: 10,
      bySource: [
        { source: "kernel", units: 7, actions: 6 },
        { source: "tacho", units: 5, actions: 4 },
        { source: "external_tool", units: 0, actions: 0 },
      ],
      byWorkspace: {
        rows: [
          {
            key: "11111111-1111-4111-8111-111111111111",
            label: HOSTILE,
            units: 12,
            actions: 10,
          },
        ],
        other: { groups: 0, units: 0, actions: 0 },
      },
      byAgent: {
        rows: [{ key: null, label: null, units: 12, actions: 10 }],
        other: { groups: 0, units: 0, actions: 0 },
      },
      byOperator: {
        rows: [{ key: "u1", label: "Dana Ops", units: 10, actions: 8 }],
        other: { groups: 3, units: 2, actions: 2 },
      },
      bySubject: {
        rows: [
          {
            capability: null,
            toolName: HOSTILE,
            mcpServer: "github",
            units: 12,
            actions: 10,
          },
        ],
        other: { groups: 0, units: 0, actions: 0 },
      },
      daily: [{ date: "2026-09-02", units: 12, actions: 10 }],
    },
    buckets: [],
    settlements: [],
    reversals: [],
    prepaidOrders: [],
    invoices: [
      {
        publicId: "inv_a",
        number: "OXG-0041",
        status: "paid",
        kind: "subscription",
        amountDueMicros: "123456789",
        amountPaidMicros: "123456789",
        amountRemainingMicros: "0",
        currency: "usd",
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        issuedAt: "2026-09-01T09:00:00.000Z",
        dueAt: null,
        paidAt: null,
        hostedInvoiceUrl: "javascript:alert(1)",
        invoicePdfUrl: null,
      },
    ],
    invoiceTotals: [
      {
        currency: "usd",
        invoices: 1,
        dueMicros: "123456789",
        paidMicros: "123456789",
        remainingMicros: "0",
      },
    ],
    usageCredits: {
      openingCredits: "1000",
      additions: [],
      deductions: [],
      closingCredits: "1000",
      assistantCredits: "0",
      assistantByOperator: [],
      assistantUnattributedCredits: "0",
    },
    modelUsage: {
      rows: [],
      other: { groups: 0, calls: 0, inputTokens: 0, outputTokens: 0 },
      billedMicros: "0",
    },
    reconciliation: [
      {
        id: "units_by_day",
        statement: "The daily series adds up.",
        holds: true,
      },
    ],
    ...overrides,
  };
}

const item: StatementLineItem = {
  id: "0192f3a4-0000-7000-8000-000000000001",
  billedAt: "2026-09-02T10:11:12.123456Z",
  occurredAt: "2026-09-02T10:11:11.000Z",
  source: "tacho",
  capability: null,
  toolName: '=HYPERLINK("http://evil")',
  mcpServer: null,
  surface: "tacho",
  harness: "claude-code",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspace: "Payments, EU",
  agentId: "agt_alpha",
  agent: "Release bot",
  operatorUserId: null,
  operator: null,
  principalId: null,
  principalKind: null,
  runId: "run_1",
  sessionId: "sess",
  toolCallId: "toolu_1",
  requestId: "req_1",
  units: 1,
};

describe("money formatting", () => {
  it("rounds micros to cents half to even at the printed figure", () => {
    expect(formatMoney("123456789", "usd")).toBe("$123.46");
    expect(formatMoney("5000", "usd")).toBe("$0.00");
    expect(formatMoney("15000", "usd")).toBe("$0.02");
    expect(formatMoney("25000", "usd")).toBe("$0.02");
    expect(formatMoney("-1234500000", "usd")).toBe("-$1,234.50");
    expect(formatMoney("1000000", "eur")).toBe("1.00 EUR");
  });

  it("prints a rate at its full precision", () => {
    expect(formatRate("4500", "usd")).toBe("$0.0045");
    expect(formatRate("2500000", "usd")).toBe("$2.50");
    expect(formatRate("1", "eur")).toBe("0.000001 EUR");
  });

  it("prints credits with their face value", () => {
    expect(formatCredits("1234")).toBe("1,234 credits ($12.34)");
    expect(formatCredits("1")).toBe("1 credit ($0.01)");
  });
});

describe("renderStatementCsv", () => {
  it("quotes RFC 4180 fields and neutralises formula-leading text", () => {
    expect(csvText("a,b")).toBe('"a,b"');
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    expect(csvText("=1+1")).toBe("'=1+1");
    expect(csvText("-2")).toBe("'-2");
    expect(csvText("@cmd")).toBe("'@cmd");
    expect(csvText(null)).toBe("");
  });

  it("writes the header block, a blank line, the columns, then one line per row", () => {
    const csv = renderStatementCsv(statement(), [item]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Oxagen billing statement,ST-0192F3A4-20260901-20260930",
    );
    expect(lines).toContain("Governed action units,12");
    expect(lines).toContain("Ledger rows in the period,10");
    expect(lines).toContain("Reconciliation,Every check holds");
    const blank = lines.indexOf("");
    expect(lines[blank + 1]).toBe(STATEMENT_LINE_ITEM_COLUMNS.join(","));
    const row = lines[blank + 2] ?? "";
    expect(
      row.startsWith(
        "0192f3a4-0000-7000-8000-000000000001,2026-09-02T10:11:12.123456Z,",
      ),
    ).toBe(true);
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(row).toContain('"Payments, EU"');
    expect(row.endsWith(",1")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("names the checks that do not hold", () => {
    const csv = renderStatementCsv(
      statement({
        reconciliation: [
          { id: "units_by_day", statement: "", holds: false },
          { id: "bucket_ledger", statement: "", holds: false },
        ],
      }),
      [],
    );
    expect(csv).toContain(
      "Reconciliation,Does not hold: units_by_day bucket_ledger",
    );
  });

  it("writes a continuation page as rows alone, so pages concatenate", () => {
    const page = renderLineItemsCsv([item, item]);
    expect(page.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(page).not.toContain("ledger_entry_id");
  });

  it("writes nothing for an empty continuation page", () => {
    expect(renderLineItemsCsv([])).toBe("");
    expect(renderLineItemsCsv([], { columnHeader: true })).toBe(
      `${STATEMENT_LINE_ITEM_COLUMNS.join(",")}\r\n`,
    );
  });

  it("carries one cell per column on every row", () => {
    const row = renderLineItemsCsv([
      { ...item, toolName: "plain", workspace: "Payments" },
    ]).trim();
    expect(row.split(",")).toHaveLength(STATEMENT_LINE_ITEM_COLUMNS.length);
  });
});

describe("renderStatementHtml", () => {
  const html = renderStatementHtml(statement());

  it("escapes every interpolated string", () => {
    expect(escapeHtml(HOSTILE)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("Acme &lt;script&gt;");
  });

  it("links only https URLs", () => {
    expect(html).not.toContain("javascript:");
    expect(html).toContain("OXG-0041");
  });

  it("is self-contained: no script, no external asset", () => {
    expect(html).not.toMatch(/<script|<link|src=|@import|url\(/i);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("carries the reference, the bill-to, the period, the summary and the footer", () => {
    expect(html).toContain("ST-0192F3A4-20260901-20260930");
    expect(html).toContain("September 2026");
    expect(html).toContain("Final for the period");
    expect(html).toContain("$123.46");
    expect(html).toContain(
      "Figures are in USD. Governed action units are billed at the contracted rate. Model tokens are reported and billed at $0.00.",
    );
  });

  it("shows a label with its raw id, an unattributed group in words, and the rest as a count", () => {
    expect(html).toContain(
      '<span class="id">11111111-1111-4111-8111-111111111111</span>',
    );
    expect(html).toContain("Not attributed");
    expect(html).toContain("3 more groups: 2 units across 2 governed actions.");
  });

  it("marks a provisional statement with a dashed border, not a colour", () => {
    const p = renderStatementHtml(statement({ provisional: true }));
    expect(p).toContain('class="status provisional"');
    expect(p).toContain("Provisional: figures run to 2 Oct 2026, 00:00 UTC");
  });

  it("rolls a long period's days up to months", () => {
    const daily = Array.from({ length: 92 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 1 + i));
      return { date: d.toISOString().slice(0, 10), units: 1, actions: 1 };
    });
    const q = renderStatementHtml(
      statement({
        governedActions: { ...statement().governedActions, daily },
      }),
    );
    expect(q).toContain("By month (UTC)");
    expect(q).toContain('September 2026</td><td class="num">30</td>');
  });

  it("says when a check does not hold", () => {
    const f = renderStatementHtml(
      statement({
        reconciliation: [
          {
            id: "units_by_day",
            statement: "The daily series adds up.",
            holds: false,
          },
        ],
      }),
    );
    expect(f).toContain('class="check fails">Does not hold');
    expect(f).toContain("1 check does not hold");
  });
});

describe("renderStatementHtml with every section populated", () => {
  const UUID = (n: number) =>
    `0192f3a4-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const bucket = {
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    includedGau: 50_000,
    purchasedGau: 10_000,
    carriedGau: 0,
    usedGau: 12,
    overageInvoicedGau: 0,
    remainingGau: 59_988,
    overageGau: 0,
    closedAt: null,
    unitsInPeriod: 12,
    ledgerUnits: 12,
    reconciliation: "matched" as const,
  };
  const settlement = {
    id: UUID(1),
    kind: "period_close" as const,
    status: "open" as const,
    quantityGau: 2,
    ratePerGauMicros: "4500",
    subtotalMicros: "9000",
    chargedMicros: "9720",
    currency: "usd",
    createdAt: "2026-09-30T23:59:59.000Z",
    settledAt: null,
    invoice: {
      number: "OXG-0042",
      status: "open",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/abc",
    },
  };
  const order = {
    id: UUID(3),
    status: "paid" as const,
    agreementRef: "MSA-2026-014",
    poNumber: "PO-7",
    currency: "usd",
    licenceMicros: "1000000000",
    licencePeriodStart: null,
    licencePeriodEnd: null,
    gauQuantity: 1_000,
    ratePerGauMicros: "4500",
    gauMicros: "4500000",
    creditMicros: "0",
    totalMicros: "1004500000",
    createdAt: "2026-09-20T00:00:00.000Z",
    paidAt: "2026-09-21T00:00:00.000Z",
    invoice: {
      number: null,
      status: "paid",
      hostedInvoiceUrl: null,
    },
  };
  const base = statement();
  const full = statement({
    agreements: [
      {
        agreementRef: "MSA-2025-003",
        currency: "usd",
        ratePerGauMicros: "5000",
        includedGauPerMonth: 20_000,
        blockSizeGau: 10_000,
        effectiveFrom: "2025-01-01T00:00:00.000Z",
        effectiveTo: "2026-09-10T00:00:00.000Z",
      },
      {
        agreementRef: `MSA-2026-014 ${HOSTILE}`,
        currency: "usd",
        ratePerGauMicros: "4500",
        includedGauPerMonth: 50_000,
        blockSizeGau: 10_000,
        effectiveFrom: "2026-09-10T00:00:00.000Z",
        effectiveTo: null,
      },
    ],
    governedActions: {
      ...base.governedActions,
      byAgent: {
        rows: [{ key: "agt_alpha", label: null, units: 12, actions: 10 }],
        other: { groups: 1, units: 1, actions: 1 },
      },
      bySubject: {
        rows: [
          {
            capability: "send_message",
            toolName: "Bash",
            mcpServer: null,
            units: 7,
            actions: 6,
          },
          {
            capability: "list_runs",
            toolName: null,
            mcpServer: null,
            units: 1,
            actions: 1,
          },
        ],
        other: { groups: 4, units: 4, actions: 3 },
      },
    },
    buckets: [
      bucket,
      {
        ...bucket,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        usedGau: 20,
        ledgerUnits: 15,
        reconciliation: "unitemised",
      },
      { ...bucket, usedGau: 3, ledgerUnits: 5, reconciliation: "mismatch" },
    ],
    settlements: [
      settlement,
      {
        ...settlement,
        id: UUID(2),
        kind: "auto_topup",
        status: "paid",
        chargedMicros: null,
        invoice: null,
      },
    ],
    reversals: [
      {
        id: UUID(4),
        kind: "refund",
        settlementId: UUID(2),
        requestedGau: 10_000,
        reversedGau: 9_000,
        unrecoveredGau: 1_000,
        amountMicros: "-45000000",
        currency: "usd",
        createdAt: "2026-09-25T12:30:00.000Z",
      },
    ],
    prepaidOrders: [
      order,
      { ...order, id: UUID(5), agreementRef: null, poNumber: null },
    ],
    invoices: [
      ...base.invoices,
      {
        ...(base.invoices[0] as BillingStatement["invoices"][number]),
        publicId: "inv_b",
        number: null,
        kind: "gau_period_close",
        status: "open",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/abc",
      },
    ],
    invoiceTotals: [
      {
        currency: "usd",
        invoices: 2,
        dueMicros: "246913578",
        paidMicros: "123456789",
        remainingMicros: "123456789",
      },
      {
        currency: "eur",
        invoices: 1,
        dueMicros: "1000000",
        paidMicros: "0",
        remainingMicros: "1000000",
      },
    ],
    usageCredits: {
      openingCredits: "1000",
      additions: [{ reason: "grant_credit_pack", credits: "500", entries: 1 }],
      deductions: [
        { reason: "consume_assistant_tokens", credits: "50", entries: 2 },
      ],
      closingCredits: "1450",
      assistantCredits: "50",
      assistantByOperator: [
        { key: "u1", label: "Dana Ops", credits: "30", entries: 1 },
        { key: "u2", label: null, credits: "1", entries: 1 },
      ],
      assistantUnattributedCredits: "19",
    },
    modelUsage: {
      rows: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          calls: 7,
          inputTokens: 1_500,
          outputTokens: 350,
          reportedCostMicros: "123000",
          currency: "USD",
        },
        {
          provider: null,
          model: "in-house-7b",
          calls: 2,
          inputTokens: 10,
          outputTokens: 5,
          reportedCostMicros: null,
          currency: "USD",
        },
      ],
      other: { groups: 3, calls: 9, inputTokens: 0, outputTokens: 0 },
      billedMicros: "0",
    },
    reconciliation: [
      { id: "a", statement: "A holds.", holds: false },
      { id: "b", statement: "B holds.", holds: false },
    ],
  });
  const html = renderStatementHtml(full);

  it("lists each agreement in force, an open-ended one as Open, escaped", () => {
    expect(html).toContain("Agreements in force during the period");
    expect(html).toContain(
      '<td>MSA-2025-003</td><td class="num">$0.005</td><td class="num">20,000</td><td>1 Jan 2025, 00:00 UTC</td><td>10 Sep 2026, 00:00 UTC</td>',
    );
    expect(html).toContain("MSA-2026-014 &lt;script&gt;");
    expect(html).toContain("<td>Open</td>");
  });

  it("prints a capability with the tool beneath it, and the subjects left out as a count", () => {
    expect(html).toContain('send_message<span class="id">Bash</span>');
    expect(html).toContain("<td>list_runs</td>");
    expect(html).toContain("4 more: 4 units across 3 governed actions.");
  });

  it("shows an unlabelled group by its raw id and names one hidden group in the singular", () => {
    expect(html).toContain("<td>agt_alpha</td>");
    expect(html).toContain("1 more group: 1 units across 1 governed actions.");
  });

  it("states each bucket's month and whether its ledger matches, falls short, or exceeds used", () => {
    expect(html).toContain("<td>1 Sep 2026 to 30 Sep 2026</td>");
    expect(html).toContain('12 <span class="muted">matches</span>');
    expect(html).toContain(
      '15 <span class="muted">(5 before the ledger)</span>',
    );
    expect(html).toContain("5 <strong>exceeds used</strong>");
  });

  it("prints each settlement's charge and invoice, linking only an https invoice", () => {
    expect(html).toContain("<td>Period close</td>");
    expect(html).toContain('<td class="num">$0.01</td>');
    expect(html).toContain(
      '<a href="https://invoice.stripe.com/i/acct/abc">OXG-0042 <span class="muted">(open)</span></a>',
    );
    expect(html).toContain('<span class="muted">Not recorded</span>');
    expect(html).toContain('<span class="muted">No invoice yet</span>');
  });

  it("lists refunds and disputes with the units withdrawn and those already used", () => {
    expect(html).toContain("Refunds and disputes");
    expect(html).toContain(
      '<td>Refund</td><td>25 Sep 2026, 12:30 UTC</td><td class="num">-$45.00</td><td class="num">10,000</td><td class="num">9,000</td><td class="num">1,000</td>',
    );
  });

  it("prints a prepaid order with its agreement and PO, or says it has none", () => {
    expect(html).toContain(
      `MSA-2026-014<span class="id">PO PO-7</span><span class="id">${UUID(3)}</span>`,
    );
    expect(html).toContain(`No agreement<span class="id">${UUID(5)}</span>`);
    expect(html).toContain('<td class="num">1,000 at $0.0045</td>');
    expect(html).toContain('<td class="num">$1,004.50</td>');
    expect(html).toContain('Unnumbered <span class="muted">(paid)</span>');
  });

  it("links an https invoice, labels an unnumbered one, and totals each currency", () => {
    expect(html).toContain(
      '<a href="https://invoice.stripe.com/i/acct/abc">Unnumbered</a><span class="id">inv_b</span>',
    );
    expect(html).toContain("<td>Gau period close</td>");
    expect(html).toContain("2 invoices in USD");
    expect(html).toContain("1 invoice in EUR");
    expect(html).toContain("<dd>$246.91 + 1.00 EUR</dd>");
    expect(html).toContain("<dd>$123.46 + 0.00 EUR</dd>");
  });

  it("walks the credit ledger from opening to closing and splits assistant spend by operator", () => {
    expect(html).toContain("<td>Added: Grant credit pack</td>");
    expect(html).toContain(
      '<td>Deducted: Consume assistant tokens</td><td class="num">2</td><td class="num">-50 credits (-$0.50)</td>',
    );
    expect(html).toContain(
      '<td>Closing balance</td><td class="num"></td><td class="num">1,450 credits ($14.50)</td>',
    );
    expect(html).toContain('Dana Ops<span class="id">u1</span>');
    expect(html).toContain("<td>u2</td>");
    expect(html).toContain(
      "19 credits ($0.19) of assistant deductions name no operator",
    );
  });

  it("reports model usage at list price, an unpriced model as such, and bills it at zero", () => {
    expect(html).toContain('claude-sonnet-5<span class="id">anthropic</span>');
    expect(html).toContain("<td>in-house-7b</td>");
    expect(html).toContain(
      '<td class="num">$0.12</td><td class="num">$0.00</td>',
    );
    expect(html).toContain('<span class="muted">Unpriced</span>');
    expect(html).toContain("3 more models: 9 calls.");
  });

  it("counts the checks that do not hold in the plural", () => {
    expect(html).toContain("2 checks do not hold");
  });

  it("names a published plan in both forms when no agreement is in force", () => {
    const published = statement({
      terms: {
        ...base.terms,
        source: "published_tier",
        tier: "team_plus",
        agreementRef: null,
      },
      invoiceTotals: [],
    });
    const page = renderStatementHtml(published);
    expect(page).toContain("<td>Published Team plus plan</td>");
    expect(page).toContain("<td>None</td>");
    expect(page).toContain("<dd>None</dd>");
    expect(renderStatementCsv(published, [])).toContain(
      "Terms,Published team_plus plan",
    );
    expect(renderStatementCsv(statement(), [])).toContain(
      "Terms,Negotiated agreement MSA-2026-014",
    );
  });

  it("leaves the share blank when the period has no units, and says each empty table is empty", () => {
    const empty = renderStatementHtml(
      statement({
        governedActions: {
          ...base.governedActions,
          totalUnits: 0,
          totalActions: 0,
          byWorkspace: {
            rows: [{ key: null, label: null, units: 0, actions: 0 }],
            other: { groups: 0, units: 0, actions: 0 },
          },
          bySubject: { rows: [], other: { groups: 0, units: 0, actions: 0 } },
        },
        invoices: [],
        invoiceTotals: [],
      }),
    );
    expect(empty).toContain(
      '<span class="muted">Not attributed</span></td><td class="num">0</td><td class="num">0</td><td class="num"></td>',
    );
    expect(empty).toContain("No month bucket overlaps this period.");
    expect(empty).toContain("No settlements in this period.");
    expect(empty).toContain("No prepaid orders in this period.");
    expect(empty).toContain("No invoices in this period.");
    expect(empty).toContain("No model usage recorded in this period.");
    expect(empty).not.toContain("Refunds and disputes");
    expect(empty).not.toContain("Agreements in force during the period");
  });
});

describe("rates and money at the edges", () => {
  it("prints a negative rate with its sign before the currency symbol", () => {
    expect(formatRate("-2500000", "usd")).toBe("-$2.50");
    expect(formatRate("-4500", "eur")).toBe("-0.0045 EUR");
    expect(formatMoney("-1000000", "eur")).toBe("-1.00 EUR");
    expect(formatCredits("-1")).toBe("-1 credit (-$0.01)");
  });

  it("leaves an empty cell empty and quotes a line break", () => {
    expect(csvText("")).toBe("");
    expect(csvText("a\nb")).toBe('"a\nb"');
    expect(csvText("\tx")).toBe("'\tx");
  });
});

describe("renderStatementCsv header states", () => {
  it("marks a provisional statement and a negotiated agreement with no reference", () => {
    const base = statement();
    const csv = renderStatementCsv(
      statement({
        provisional: true,
        terms: { ...base.terms, agreementRef: null },
      }),
      [],
    );
    expect(csv).toContain("Status,Provisional: the period has not ended");
    expect(csv).toContain("\r\nTerms,Negotiated agreement\r\n");
  });

  it("does not link an invoice URL that does not parse", () => {
    const base = statement();
    const html = renderStatementHtml(
      statement({
        invoices: [
          {
            ...(base.invoices[0] as BillingStatement["invoices"][number]),
            hostedInvoiceUrl: "not a url",
          },
        ],
      }),
    );
    expect(html).not.toContain("not a url");
    expect(html).toContain('OXG-0041<span class="id">inv_a</span>');
  });
});
