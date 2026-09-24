/**
 * statement-render.ts — a billing statement as a file (ADR-165).
 *
 *   renderStatementCsv   the header block and one line per ledger row
 *   renderStatementHtml  one self-contained, printable document
 *
 * Both take the statement `buildBillingStatement` returned and add nothing to
 * it: no figure here is computed except for display (money rounded to cents
 * half to even, once, at the printed figure; the statement keeps micros).
 *
 * Every interpolated string is escaped for its format. A CSV text cell that
 * opens with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with
 * an apostrophe, so a tool or agent name cannot run as a spreadsheet formula
 * (CSV injection). The HTML links only `https:` URLs.
 */

import { STATEMENT_LINE_ITEM_COLUMNS } from "@oxagen/oxagen/contracts/billing.statement.export";
import type {
  BillingStatement,
  StatementGroup,
  StatementInvoiceRef,
  StatementOther,
} from "@oxagen/oxagen/contracts/billing.statement.get";
import { microsToCentsHalfEven } from "./cost-rollup";
import { formatStatementDay, type StatementLineItem } from "./statements";

// ── Shared formatting ───────────────────────────────────────────────────────

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function int(n: number | bigint): string {
  return INTEGER.format(n);
}

function currencyCode(currency: string): string {
  return currency.toUpperCase();
}

/** Integer micro-units as money, rounded to cents half to even: "$1,234.56", "1,234.56 EUR". */
export function formatMoney(micros: string, currency: string): string {
  const cents = microsToCentsHalfEven(BigInt(micros));
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = String(abs % 100n).padStart(2, "0");
  const figure = `${INTEGER.format(whole)}.${frac}`;
  const signed = negative ? `-${figure}` : figure;
  return currencyCode(currency) === "USD"
    ? negative
      ? `-$${figure}`
      : `$${figure}`
    : `${signed} ${currencyCode(currency)}`;
}

/**
 * A rate in micros at its full precision, trailing zeros trimmed to two
 * decimals: 5000 micros is "$0.005", 2500000 is "$2.50".
 */
export function formatRate(micros: string, currency: string): string {
  const value = BigInt(micros);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  let frac = String(abs % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  const figure = `${negative ? "-" : ""}${INTEGER.format(whole)}.${frac}`;
  return currencyCode(currency) === "USD"
    ? figure.startsWith("-")
      ? `-$${figure.slice(1)}`
      : `$${figure}`
    : `${figure} ${currencyCode(currency)}`;
}

/** Whole credits with their face value: "1,234 credits ($12.34)". One credit is one cent. */
export function formatCredits(credits: string): string {
  const n = BigInt(credits);
  return `${int(n)} ${n === 1n || n === -1n ? "credit" : "credits"} (${formatMoney((n * 10_000n).toString(), "usd")})`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 quoting, with a leading apostrophe on anything a spreadsheet would evaluate. */
export function csvText(value: string | null): string {
  if (value === null || value === "") return "";
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvLine(cells: string[]): string {
  return cells.join(",");
}

function csvHeaderBlock(s: BillingStatement): string[] {
  const credits = s.usageCredits;
  const pair = (k: string, v: string) => csvLine([csvText(k), csvText(v)]);
  return [
    pair("Oxagen billing statement", s.reference),
    pair("Organization", s.org.name),
    pair("Organization id", s.org.id),
    pair("Period", s.period.label),
    pair("Period start (UTC)", s.period.start),
    pair("Period end (UTC, exclusive)", s.period.end),
    pair("Generated at (UTC)", s.generatedAt),
    pair(
      "Status",
      s.provisional
        ? "Provisional: the period has not ended"
        : "Final for the period",
    ),
    pair("Currency", currencyCode(s.terms.currency)),
    pair(
      "Terms",
      s.terms.source === "negotiated"
        ? `Negotiated agreement ${s.terms.agreementRef ?? ""}`.trim()
        : `Published ${s.terms.tier} plan`,
    ),
    pair("Rate per governed action unit (micros)", s.terms.ratePerGauMicros),
    pair("Governed action units", String(s.governedActions.totalUnits)),
    // The complete file carries exactly this many rows below the column line.
    pair("Ledger rows in the period", String(s.governedActions.totalActions)),
    pair("Usage credits opening", credits.openingCredits),
    pair("Usage credits closing", credits.closingCredits),
    pair("Model tokens billed (micros)", s.modelUsage.billedMicros),
    pair(
      "Reconciliation",
      s.reconciliation.every((c) => c.holds)
        ? "Every check holds"
        : `Does not hold: ${s.reconciliation
            .filter((c) => !c.holds)
            .map((c) => c.id)
            .join(" ")}`,
    ),
    "",
  ];
}

function lineItemCells(item: StatementLineItem): string[] {
  return [
    csvText(item.id),
    csvText(item.billedAt),
    csvText(item.occurredAt),
    csvText(item.source),
    csvText(item.capability),
    csvText(item.toolName),
    csvText(item.mcpServer),
    csvText(item.surface),
    csvText(item.harness),
    csvText(item.workspaceId),
    csvText(item.workspace),
    csvText(item.agentId),
    csvText(item.agent),
    csvText(item.operatorUserId),
    csvText(item.operator),
    csvText(item.principalId),
    csvText(item.principalKind),
    csvText(item.runId),
    csvText(item.sessionId),
    csvText(item.toolCallId),
    csvText(item.requestId),
    String(item.units),
  ];
}

/**
 * Ledger rows as CSV lines, each ending CRLF. A continuation page is this
 * alone, so pages concatenate into one file.
 */
export function renderLineItemsCsv(
  lineItems: readonly StatementLineItem[],
  opts: { columnHeader?: boolean } = {},
): string {
  const lines: string[] = [];
  if (opts.columnHeader) lines.push(STATEMENT_LINE_ITEM_COLUMNS.join(","));
  for (const item of lineItems) lines.push(csvLine(lineItemCells(item)));
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}

/**
 * The statement's first CSV page: a two-column header block, a blank line,
 * the column line, then one line per ledger row. Later pages are
 * {@link renderLineItemsCsv} alone.
 */
export function renderStatementCsv(
  statement: BillingStatement,
  lineItems: readonly StatementLineItem[],
): string {
  return `${csvHeaderBlock(statement).join("\r\n")}\r\n${renderLineItemsCsv(lineItems, { columnHeader: true })}`;
}

// ── HTML ────────────────────────────────────────────────────────────────────

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

const e = escapeHtml;

function safeHttpsUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** "1 Sep 2026, 14:03 UTC". */
function when(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatStatementDay(d)}, ${hh}:${mm} UTC`;
}

function day(iso: string): string {
  return formatStatementDay(new Date(iso));
}

function humanise(word: string): string {
  const s = word.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Column<R> {
  head: string;
  cell: (row: R) => string;
  numeric?: boolean;
}

function table<R>(
  rows: readonly R[],
  columns: readonly Column<R>[],
  opts: { empty: string; foot?: string[] },
): string {
  if (rows.length === 0) return `<p class="empty">${e(opts.empty)}</p>`;
  const cls = (c: Column<R>) => (c.numeric ? ' class="num"' : "");
  const head = columns.map((c) => `<th scope="col"${cls(c)}>${e(c.head)}</th>`);
  const body = rows.map(
    (r) =>
      `<tr>${columns.map((c) => `<td${cls(c)}>${c.cell(r)}</td>`).join("")}</tr>`,
  );
  const foot = opts.foot
    ? `<tfoot><tr>${opts.foot
        .map((cell, i) => `<td${cls(columns[i] as Column<R>)}>${cell}</td>`)
        .join("")}</tr></tfoot>`
    : "";
  return `<table><thead><tr>${head.join("")}</tr></thead><tbody>${body.join("")}</tbody>${foot}</table>`;
}

/** A label with its raw id beneath it, or "Not attributed". */
function labelCell(key: string | null, label: string | null): string {
  if (key === null) return `<span class="muted">Not attributed</span>`;
  const primary = label ?? key;
  const id = label === null ? "" : `<span class="id">${e(key)}</span>`;
  return `${e(primary)}${id}`;
}

function invoiceRefCell(ref: StatementInvoiceRef | null): string {
  if (ref === null) return `<span class="muted">No invoice yet</span>`;
  const text = `${e(ref.number ?? "Unnumbered")} <span class="muted">(${e(ref.status)})</span>`;
  const url = safeHttpsUrl(ref.hostedInvoiceUrl);
  return url ? `<a href="${e(url)}">${text}</a>` : text;
}

function groupTable(
  title: string,
  keyHead: string,
  b: { rows: StatementGroup[]; other: StatementOther },
  total: number,
): string {
  const rows = [...b.rows];
  const cols: Column<StatementGroup>[] = [
    { head: keyHead, cell: (r) => labelCell(r.key, r.label) },
    { head: "Governed actions", cell: (r) => int(r.actions), numeric: true },
    { head: "Units", cell: (r) => int(r.units), numeric: true },
    {
      head: "Share",
      cell: (r) =>
        total === 0 ? "" : `${((r.units / total) * 100).toFixed(1)}%`,
      numeric: true,
    },
  ];
  const otherRow =
    b.other.groups > 0
      ? `<p class="note">${int(b.other.groups)} more ${b.other.groups === 1 ? "group" : "groups"}: ${int(b.other.units)} units across ${int(b.other.actions)} governed actions. Every row is in the CSV export.</p>`
      : "";
  return `<h3>${e(title)}</h3>${table(rows, cols, { empty: "No governed actions in this period." })}${otherRow}`;
}

/** Days rolled up to months when the period is longer than two months. */
function seriesRows(s: BillingStatement) {
  const daily = s.governedActions.daily;
  if (daily.length <= 62)
    return {
      head: "Day",
      rows: daily.map((d) => ({
        key: day(`${d.date}T00:00:00Z`),
        units: d.units,
        actions: d.actions,
      })),
    };
  const months = new Map<string, { units: number; actions: number }>();
  for (const d of daily) {
    const k = d.date.slice(0, 7);
    const m = months.get(k) ?? { units: 0, actions: 0 };
    m.units += d.units;
    m.actions += d.actions;
    months.set(k, m);
  }
  return {
    head: "Month",
    rows: [...months.entries()].map(([k, m]) => {
      const d = new Date(`${k}-01T00:00:00Z`);
      return {
        key: d.toLocaleString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        ...m,
      };
    }),
  };
}

const STYLE = `
:root{--ink:#09090B;--body:#27272A;--muted:#71717A;--rule:#D4D4D8;--hl:#F4F4F5;--gold:#D4AF37;--gold-deep:#8A7223}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;color:var(--body);background:#fff;font:10.5pt/1.45 system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:190mm;margin:0 auto;padding:14mm 0}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;border-bottom:2px solid var(--ink);padding-bottom:5mm;margin-bottom:6mm}
.brand{display:flex;align-items:center;gap:3mm;color:var(--ink)}
.brand svg{width:9mm;height:9mm}
.wordmark{font-size:18pt;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.doc{text-align:right}
.doc h1{margin:0 0 1mm;font-size:15pt;color:var(--ink);font-weight:600}
.doc p{margin:0;font-size:9pt}
.ref{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.status{display:inline-block;margin-top:2mm;padding:1mm 2.5mm;border:1px solid var(--ink);border-radius:2px;font-size:8.5pt}
.status.provisional{border-style:dashed}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:8mm;margin-bottom:6mm}
.parties h2,.summary h2{margin:0 0 1mm;font-size:8.5pt;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.parties p{margin:0}
.summary{border:1px solid var(--ink);border-radius:3px;padding:4mm 5mm;margin-bottom:6mm;break-inside:avoid}
.summary dl{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm 6mm;margin:2mm 0 0}
.summary dt{font-size:8.5pt;color:var(--muted)}
.summary dd{margin:0;font-size:12pt;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
section{margin-bottom:7mm}
h2.section{font-size:12pt;color:var(--ink);margin:0 0 2mm;padding-bottom:1mm;border-bottom:1px solid var(--rule);break-after:avoid}
h3{font-size:10pt;color:var(--ink);margin:4mm 0 1.5mm;break-after:avoid}
table{width:100%;border-collapse:collapse;font-size:9pt;font-variant-numeric:tabular-nums}
thead{display:table-header-group}
tfoot td{font-weight:600;border-top:1.5px solid var(--ink)}
th{text-align:left;font-weight:600;color:var(--ink);border-bottom:1.5px solid var(--ink);padding:1.2mm 2mm}
td{border-bottom:1px solid var(--rule);padding:1.2mm 2mm;vertical-align:top}
tbody th{font-weight:600;border-bottom:1px solid var(--rule);width:45%}
tr{break-inside:avoid}
.num{text-align:right;white-space:nowrap}
.id{display:block;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:7.5pt;color:var(--muted);word-break:break-all}
.muted{color:var(--muted)}
.empty,.note{margin:1mm 0;font-size:9pt;color:var(--muted)}
.check{display:inline-block;min-width:22mm;padding:.4mm 2mm;border:1px solid var(--ink);border-radius:2px;font-size:8pt;text-align:center}
.check.fails{border-width:2px;border-style:double}
ul.notes{margin:1mm 0 0;padding-left:5mm;font-size:9pt}
ul.notes li{margin-bottom:1mm}
footer{border-top:1px solid var(--rule);padding-top:3mm;font-size:8.5pt;color:var(--muted)}
a{color:var(--gold-deep)}
@page{margin:14mm}
@media print{main{padding:0;max-width:none}a{color:var(--ink);text-decoration:none}}
`;

/** The hive mark from the house brand kit, drawn inline so the file needs nothing else. */
const MARK = `<svg viewBox="-7 -7 34 35" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1"><path d="M0 -6.08L5.8 -3.04L5.8 3.04L0 6.08L-5.8 3.04L-5.8 -3.04Z"/><path d="M13.08 -6.08L18.88 -3.04L18.88 3.04L13.08 6.08L7.28 3.04L7.28 -3.04Z"/><path d="M6.54 4.16L12.34 7.2L12.34 13.28L6.54 16.32L0.74 13.28L0.74 7.2Z"/><path d="M13.08 14.4L18.88 17.44L18.88 23.52L13.08 26.56L7.28 23.52L7.28 17.44Z"/></g><path d="M19.62 3.66L25.9 6.95L25.9 13.53L19.62 16.82L13.34 13.53L13.34 6.95Z" fill="#D4AF37"/><path d="M0 13.9L6.28 17.19L6.28 23.77L0 27.06L-6.28 23.77L-6.28 17.19Z" fill="#D4AF37" opacity=".55"/></svg>`;

/**
 * The statement as one printable HTML document: inline CSS, the mark drawn
 * inline, no script, no external asset. Prints to A4 and US Letter; table
 * headers repeat across pages and rows do not split.
 */
export function renderStatementHtml(s: BillingStatement): string {
  const cur = s.terms.currency;
  const ga = s.governedActions;
  const total = ga.totalUnits;
  const invTotals = s.invoiceTotals;
  const invoicedLine =
    invTotals.length === 0
      ? "None"
      : invTotals.map((t) => formatMoney(t.dueMicros, t.currency)).join(" + ");
  const paidLine =
    invTotals.length === 0
      ? "None"
      : invTotals.map((t) => formatMoney(t.paidMicros, t.currency)).join(" + ");
  const series = seriesRows(s);
  const credits = s.usageCredits;

  const termsFacts = [
    [
      "Terms",
      s.terms.source === "negotiated"
        ? "Negotiated agreement"
        : `Published ${humanise(s.terms.tier)} plan`,
    ],
    ["Agreement", s.terms.agreementRef ?? "None"],
    [
      "Rate per governed action unit",
      formatRate(s.terms.ratePerGauMicros, cur),
    ],
    ["Included units per month", int(s.terms.includedGauPerMonth)],
    ["Block size", `${int(s.terms.blockSizeGau)} units`],
    ["In force at", when(s.terms.asOf)],
  ];

  const sections: string[] = [];

  sections.push(`<section><h2 class="section">Terms in force</h2>
<table><tbody>${termsFacts.map(([k, v]) => `<tr><th scope="row">${e(k as string)}</th><td>${e(v as string)}</td></tr>`).join("")}</tbody></table>
${
  s.agreements.length > 0
    ? `<h3>Agreements in force during the period</h3>${table(
        s.agreements,
        [
          { head: "Agreement", cell: (a) => e(a.agreementRef) },
          {
            head: "Rate per unit",
            cell: (a) => e(formatRate(a.ratePerGauMicros, a.currency)),
            numeric: true,
          },
          {
            head: "Included per month",
            cell: (a) => int(a.includedGauPerMonth),
            numeric: true,
          },
          { head: "From", cell: (a) => e(when(a.effectiveFrom)) },
          {
            head: "To",
            cell: (a) => (a.effectiveTo ? e(when(a.effectiveTo)) : "Open"),
          },
        ],
        { empty: "" },
      )}`
    : ""
}
<p class="note">Each settlement and prepaid order below records the rate it charged when it was made.</p></section>`);

  sections.push(`<section><h2 class="section">Governed actions</h2>
<p class="note">One governed action is one ledger row: a capability call, or a tool call a wrapped harness made, that Oxagen governed and billed. Rows are counted when their units were billed to a month bucket, the same instant the invoices count them.</p>
<h3>By source</h3>${table(
    ga.bySource,
    [
      {
        head: "Source",
        cell: (r) =>
          e(
            r.source === "kernel"
              ? "Capability calls"
              : r.source === "tacho"
                ? "Wrapped harness tool calls"
                : "External MCP tool calls",
          ),
      },
      { head: "Governed actions", cell: (r) => int(r.actions), numeric: true },
      { head: "Units", cell: (r) => int(r.units), numeric: true },
    ],
    { empty: "", foot: ["Total", int(ga.totalActions), int(total)] },
  )}
${groupTable("By workspace", "Workspace", ga.byWorkspace, total)}
${groupTable("By agent", "Agent", ga.byAgent, total)}
${groupTable("By operator", "Operator", ga.byOperator, total)}
<h3>By capability or tool</h3>${table(
    ga.bySubject.rows,
    [
      {
        head: "Capability or tool",
        cell: (r) =>
          r.capability !== null
            ? `${e(r.capability)}${r.toolName ? `<span class="id">${e(r.toolName)}</span>` : ""}`
            : e(r.toolName ?? ""),
      },
      { head: "Tool server", cell: (r) => e(r.mcpServer ?? "") },
      { head: "Governed actions", cell: (r) => int(r.actions), numeric: true },
      { head: "Units", cell: (r) => int(r.units), numeric: true },
    ],
    { empty: "No governed actions in this period." },
  )}${
    ga.bySubject.other.groups > 0
      ? `<p class="note">${int(ga.bySubject.other.groups)} more: ${int(ga.bySubject.other.units)} units across ${int(ga.bySubject.other.actions)} governed actions.</p>`
      : ""
  }
<h3>By ${series.head === "Day" ? "day" : "month"} (UTC)</h3>${table(
    series.rows,
    [
      { head: series.head, cell: (r) => e(r.key) },
      { head: "Governed actions", cell: (r) => int(r.actions), numeric: true },
      { head: "Units", cell: (r) => int(r.units), numeric: true },
    ],
    { empty: "" },
  )}</section>`);

  sections.push(`<section><h2 class="section">Month buckets</h2>
<p class="note">Each bucket is one month of governed action units. Remaining is included plus purchased plus carried, minus used. Ledger units are every unit the ledger added to the bucket, all months included.</p>
${table(
  s.buckets,
  [
    {
      head: "Month",
      cell: (b) =>
        `${e(day(b.periodStart))} to ${e(day(new Date(new Date(b.periodEnd).getTime() - 1).toISOString()))}`,
    },
    { head: "Included", cell: (b) => int(b.includedGau), numeric: true },
    { head: "Purchased", cell: (b) => int(b.purchasedGau), numeric: true },
    { head: "Carried", cell: (b) => int(b.carriedGau), numeric: true },
    { head: "Used", cell: (b) => int(b.usedGau), numeric: true },
    { head: "Overage", cell: (b) => int(b.overageGau), numeric: true },
    {
      head: "Overage invoiced",
      cell: (b) => int(b.overageInvoicedGau),
      numeric: true,
    },
    {
      head: "In this period",
      cell: (b) => int(b.unitsInPeriod),
      numeric: true,
    },
    {
      head: "Ledger",
      cell: (b) =>
        b.reconciliation === "matched"
          ? `${int(b.ledgerUnits)} <span class="muted">matches</span>`
          : b.reconciliation === "unitemised"
            ? `${int(b.ledgerUnits)} <span class="muted">(${int(b.usedGau - b.ledgerUnits)} before the ledger)</span>`
            : `${int(b.ledgerUnits)} <strong>exceeds used</strong>`,
      numeric: true,
    },
  ],
  { empty: "No month bucket overlaps this period." },
)}</section>`);

  sections.push(`<section><h2 class="section">Settlements</h2>
<p class="note">Block purchases, auto top-ups, interim and period-close charges created or paid in the period. Subtotal is quantity times the rate recorded when the charge was made. Charged is what the payment processor took, tax included.</p>
${table(
  s.settlements,
  [
    { head: "Kind", cell: (r) => e(humanise(r.kind)) },
    { head: "Created", cell: (r) => e(when(r.createdAt)) },
    { head: "Units", cell: (r) => int(r.quantityGau), numeric: true },
    {
      head: "Rate",
      cell: (r) => e(formatRate(r.ratePerGauMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Subtotal",
      cell: (r) => e(formatMoney(r.subtotalMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Charged",
      cell: (r) =>
        r.chargedMicros === null
          ? `<span class="muted">Not recorded</span>`
          : e(formatMoney(r.chargedMicros, r.currency)),
      numeric: true,
    },
    { head: "Status", cell: (r) => e(humanise(r.status)) },
    { head: "Invoice", cell: (r) => invoiceRefCell(r.invoice) },
  ],
  { empty: "No settlements in this period." },
)}
${
  s.reversals.length > 0
    ? `<h3>Refunds and disputes</h3>${table(
        s.reversals,
        [
          { head: "Kind", cell: (r) => e(humanise(r.kind)) },
          { head: "Recorded", cell: (r) => e(when(r.createdAt)) },
          {
            head: "Amount",
            cell: (r) => e(formatMoney(r.amountMicros, r.currency)),
            numeric: true,
          },
          {
            head: "Units requested",
            cell: (r) => int(r.requestedGau),
            numeric: true,
          },
          {
            head: "Units withdrawn",
            cell: (r) => int(r.reversedGau),
            numeric: true,
          },
          {
            head: "Already used",
            cell: (r) => int(r.unrecoveredGau),
            numeric: true,
          },
        ],
        { empty: "" },
      )}`
    : ""
}</section>`);

  sections.push(`<section><h2 class="section">Prepaid orders</h2>
${table(
  s.prepaidOrders,
  [
    {
      head: "Order",
      cell: (r) =>
        `${e(r.agreementRef ?? "No agreement")}${r.poNumber ? `<span class="id">PO ${e(r.poNumber)}</span>` : ""}<span class="id">${e(r.id)}</span>`,
    },
    {
      head: "Licence",
      cell: (r) => e(formatMoney(r.licenceMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Units",
      cell: (r) =>
        `${int(r.gauQuantity)} at ${e(formatRate(r.ratePerGauMicros, r.currency))}`,
      numeric: true,
    },
    {
      head: "Units amount",
      cell: (r) => e(formatMoney(r.gauMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Usage credits",
      cell: (r) => e(formatMoney(r.creditMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Total",
      cell: (r) => e(formatMoney(r.totalMicros, r.currency)),
      numeric: true,
    },
    { head: "Status", cell: (r) => e(humanise(r.status)) },
    { head: "Invoice", cell: (r) => invoiceRefCell(r.invoice) },
  ],
  { empty: "No prepaid orders in this period." },
)}</section>`);

  sections.push(`<section><h2 class="section">Invoices</h2>
<p class="note">Invoices issued or paid in the period. Drafts are not listed. A void invoice is listed and left out of the totals.</p>
${table(
  s.invoices,
  [
    {
      head: "Invoice",
      cell: (r) => {
        const url = safeHttpsUrl(r.hostedInvoiceUrl);
        const text = e(r.number ?? "Unnumbered");
        return `${url ? `<a href="${e(url)}">${text}</a>` : text}<span class="id">${e(r.publicId)}</span>`;
      },
    },
    { head: "For", cell: (r) => e(humanise(r.kind)) },
    { head: "Issued", cell: (r) => e(when(r.issuedAt)) },
    {
      head: "Billing period",
      cell: (r) => `${e(day(r.periodStart))} to ${e(day(r.periodEnd))}`,
    },
    {
      head: "Due",
      cell: (r) => e(formatMoney(r.amountDueMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Paid",
      cell: (r) => e(formatMoney(r.amountPaidMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Remaining",
      cell: (r) => e(formatMoney(r.amountRemainingMicros, r.currency)),
      numeric: true,
    },
    { head: "Status", cell: (r) => e(humanise(r.status)) },
  ],
  { empty: "No invoices in this period." },
)}
${
  invTotals.length > 0
    ? table(
        invTotals,
        [
          {
            head: "Totals",
            cell: (t) =>
              `${int(t.invoices)} ${t.invoices === 1 ? "invoice" : "invoices"} in ${e(currencyCode(t.currency))}`,
          },
          {
            head: "Due",
            cell: (t) => e(formatMoney(t.dueMicros, t.currency)),
            numeric: true,
          },
          {
            head: "Paid",
            cell: (t) => e(formatMoney(t.paidMicros, t.currency)),
            numeric: true,
          },
          {
            head: "Remaining",
            cell: (t) => e(formatMoney(t.remainingMicros, t.currency)),
            numeric: true,
          },
        ],
        { empty: "" },
      )
    : ""
}</section>`);

  const movementRows = [
    {
      label: "Opening balance",
      credits: credits.openingCredits,
      entries: null as number | null,
    },
    ...credits.additions.map((m) => ({
      label: `Added: ${humanise(m.reason)}`,
      credits: m.credits,
      entries: m.entries as number | null,
    })),
    ...credits.deductions.map((m) => ({
      label: `Deducted: ${humanise(m.reason)}`,
      credits: `-${m.credits}`,
      entries: m.entries as number | null,
    })),
  ];
  sections.push(`<section><h2 class="section">Usage credits</h2>
<p class="note">Usage credits pay for the in-app assistant's model tokens on the platform's key. One credit is one cent. Figures are the credit ledger's. Credits that expire unused leave no ledger entry, so the balance on the Billing page can be lower by the expired amount.</p>
${table(
  movementRows,
  [
    { head: "Entry", cell: (r) => e(r.label) },
    {
      head: "Ledger entries",
      cell: (r) => (r.entries === null ? "" : int(r.entries)),
      numeric: true,
    },
    {
      head: "Credits",
      cell: (r) => e(formatCredits(r.credits)),
      numeric: true,
    },
  ],
  {
    empty: "",
    foot: ["Closing balance", "", e(formatCredits(credits.closingCredits))],
  },
)}
<h3>Assistant model tokens by operator</h3>${table(
    credits.assistantByOperator,
    [
      { head: "Operator", cell: (r) => labelCell(r.key, r.label) },
      { head: "Ledger entries", cell: (r) => int(r.entries), numeric: true },
      {
        head: "Credits",
        cell: (r) => e(formatCredits(r.credits)),
        numeric: true,
      },
    ],
    { empty: "No assistant deduction in this period names an operator." },
  )}${
    BigInt(credits.assistantUnattributedCredits) > 0n
      ? `<p class="note">${e(formatCredits(credits.assistantUnattributedCredits))} of assistant deductions name no operator: background work, or entries recorded before the ledger named the person.</p>`
      : ""
  }</section>`);

  const mu = s.modelUsage;
  sections.push(`<section><h2 class="section">Model usage</h2>
<p class="note">Model calls recorded for runs that started on the days this period touches. Reported for your records at the model vendor's list price. Oxagen bills these at ${e(formatMoney(mu.billedMicros, cur))}.</p>
${table(
  mu.rows,
  [
    {
      head: "Model",
      cell: (r) =>
        `${e(r.model)}${r.provider ? `<span class="id">${e(r.provider)}</span>` : ""}`,
    },
    { head: "Calls", cell: (r) => int(r.calls), numeric: true },
    { head: "Input tokens", cell: (r) => int(r.inputTokens), numeric: true },
    { head: "Output tokens", cell: (r) => int(r.outputTokens), numeric: true },
    {
      head: "Vendor list cost",
      cell: (r) =>
        r.reportedCostMicros === null
          ? `<span class="muted">Unpriced</span>`
          : e(formatMoney(r.reportedCostMicros, r.currency)),
      numeric: true,
    },
    {
      head: "Billed by Oxagen",
      cell: () => e(formatMoney("0", cur)),
      numeric: true,
    },
  ],
  { empty: "No model usage recorded in this period." },
)}${
  mu.other.groups > 0
    ? `<p class="note">${int(mu.other.groups)} more models: ${int(mu.other.calls)} calls.</p>`
    : ""
}</section>`);

  sections.push(`<section><h2 class="section">Reconciliation</h2>
${table(
  s.reconciliation,
  [
    { head: "Check", cell: (c) => e(c.statement) },
    {
      head: "Result",
      cell: (c) =>
        c.holds
          ? `<span class="check">Holds</span>`
          : `<span class="check fails">Does not hold</span>`,
    },
  ],
  { empty: "" },
)}
<ul class="notes">
<li>Governed action units come from the per-action ledger, selected on the instant each action was billed to a month bucket. Every row in the CSV export of this statement is one of the units counted here, with its workspace, agent, operator, run and tool call.</li>
<li>A month bucket's used units equal the ledger rows billed to it, because the ledger row and the bucket's count are written in one transaction.</li>
<li>Settlements, prepaid orders and invoices are listed when created or paid in the period, so one record can appear on two consecutive statements. Each line shows both dates.</li>
<li>Money is kept in micro-units and rounded to cents half to even once, at each printed figure.</li>
</ul></section>`);

  const statusClass = s.provisional ? "status provisional" : "status";
  const statusText = s.provisional
    ? `Provisional: figures run to ${when(s.generatedAt)}`
    : "Final for the period";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(`Billing statement ${s.reference}, ${s.org.name}, ${s.period.label}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="top">
<div class="brand">${MARK}<span class="wordmark">oxagen</span></div>
<div class="doc"><h1>Billing statement</h1><p class="ref">${e(s.reference)}</p><p>Generated ${e(when(s.generatedAt))}</p><span class="${statusClass}">${e(statusText)}</span></div>
</header>
<div class="parties">
<div><h2>Bill to</h2><p><strong>${e(s.org.name)}</strong></p><p class="id">${e(s.org.slug)} · ${e(s.org.id)}</p></div>
<div><h2>Period</h2><p><strong>${e(s.period.label)}</strong></p><p class="muted">${e(when(s.period.start))} to ${e(when(s.period.end))}, end exclusive</p></div>
</div>
<div class="summary"><h2>Summary</h2><dl>
<div><dt>Governed action units</dt><dd>${int(total)}</dd></div>
<div><dt>Invoiced</dt><dd>${e(invoicedLine)}</dd></div>
<div><dt>Paid</dt><dd>${e(paidLine)}</dd></div>
<div><dt>Usage credits at close</dt><dd>${e(int(BigInt(credits.closingCredits)))}</dd></div>
<div><dt>Rate per unit</dt><dd>${e(formatRate(s.terms.ratePerGauMicros, cur))}</dd></div>
<div><dt>Governed actions</dt><dd>${int(ga.totalActions)}</dd></div>
<div><dt>Model tokens billed</dt><dd>${e(formatMoney("0", cur))}</dd></div>
<div><dt>Reconciliation</dt><dd>${s.reconciliation.every((c) => c.holds) ? "Every check holds" : `${s.reconciliation.filter((c) => !c.holds).length} ${s.reconciliation.filter((c) => !c.holds).length === 1 ? "check does" : "checks do"} not hold`}</dd></div>
</dl></div>
${sections.join("\n")}
<footer><p>Figures are in ${e(currencyCode(cur))}. Governed action units are billed at the contracted rate. Model tokens are reported and billed at ${e(formatMoney("0", cur))}.</p><p>Statement ${e(s.reference)} for ${e(s.org.name)}. Regenerating it for the same period gives the same reference.</p></footer>
</main>
</body>
</html>
`;
}
