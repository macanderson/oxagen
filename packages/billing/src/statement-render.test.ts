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
