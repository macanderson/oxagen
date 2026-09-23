/**
 * `oxagen billing statement …` — CLI parity surface for
 * `get_billing_statement` and `export_billing_statement` (ADR-158).
 *
 *   oxagen billing statement --period month --anchor 2026-09-01
 *   oxagen billing statement --period quarter --anchor 2026-07-01 --json
 *   oxagen billing statement --period custom --from 2026-09-01T00:00:00Z \
 *                            --to 2026-09-10T00:00:00Z --format csv --out sept.csv
 *   oxagen billing statement --period year --anchor 2026-01-01 --format html --out 2026.html
 *
 * `--format summary` (the default) reads the statement and prints its totals
 * and reconciliation checks; with `--json` it emits the contract payload as
 * one line on stdout. `--format csv` pages every ledger row of the period
 * through the export's cursor and writes the pages, in order, to `--out` or
 * stdout; `--format html` writes the printable document. An omitted
 * `--anchor` is today (UTC), so `--period month` alone is this month so far.
 *
 * Both calls go through the shared org-scoped API client in lib/api.ts, as
 * POST /billing/statement and POST /billing/statement/export. Only an org
 * Owner, Admin or Billing member (for an API key, its creator) may read a
 * statement.
 *
 * Output discipline (ADR-023 §4): data on stdout, progress on stderr,
 * failures as uniform stderr error lines (exit 2 for a bad flag, exit 1 for
 * an API failure).
 */
import { appendFile, writeFile } from "node:fs/promises";
import { apiPostOrThrow, printTable } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { createOutput } from "../lib/output.js";

const PERIODS = ["week", "month", "quarter", "year", "custom"] as const;
type Period = (typeof PERIODS)[number];
const FORMATS = ["summary", "csv", "html"] as const;
type Format = (typeof FORMATS)[number];

/** Pages one export is allowed before the command stops: 50,000 rows each is 5e8 rows. */
const MAX_PAGES = 10_000;

// ── Output shapes (the parts of the contract output this command prints) ──

interface StatementSummary {
  reference: string;
  provisional: boolean;
  org: { name: string; slug: string };
  period: { label: string; start: string; end: string };
  terms: { currency: string; ratePerGauMicros: string; source: string };
  governedActions: {
    totalUnits: number;
    totalActions: number;
    bySource: { source: string; units: number; actions: number }[];
  };
  invoiceTotals: {
    currency: string;
    invoices: number;
    dueMicros: string;
    paidMicros: string;
  }[];
  usageCredits: { openingCredits: string; closingCredits: string };
  reconciliation: { id: string; holds: boolean }[];
}

interface ExportPage {
  reference: string;
  filename: string;
  content: string;
  lines: number;
  nextCursor: string | null;
}

export interface BillingStatementCliOptions {
  period?: string;
  anchor?: string;
  from?: string;
  to?: string;
  format?: string;
  out?: string;
  top?: string;
  pageSize?: string;
  json?: boolean;
}

/** What the command reaches outside itself; a test swaps these. */
export interface BillingStatementDeps {
  post: <T>(path: string, body: unknown) => Promise<T>;
  writeFile: (path: string, content: string) => Promise<void>;
  appendFile: (path: string, content: string) => Promise<void>;
  today: () => string;
}

const defaultDeps: BillingStatementDeps = {
  post: (path, body) => apiPostOrThrow(path, body),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
  appendFile: (path, content) => appendFile(path, content, "utf8"),
  today: () => new Date().toISOString().slice(0, 10),
};

function isPeriod(v: string): v is Period {
  return (PERIODS as readonly string[]).includes(v);
}

function isFormat(v: string): v is Format {
  return (FORMATS as readonly string[]).includes(v);
}

/** Micros as a two-decimal figure for the terminal. Display only. */
function money(micros: string, currency: string): string {
  const cents = BigInt(micros) / 10_000n;
  const whole = cents / 100n;
  const frac = String((cents < 0n ? -cents : cents) % 100n).padStart(2, "0");
  return `${whole.toString()}.${frac} ${currency.toUpperCase()}`;
}

function renderSummary(s: StatementSummary, writer: CommandWriter): void {
  writer.write(
    `${s.reference}  ${s.org.name} (${s.org.slug})  ${s.period.label}${s.provisional ? "  provisional" : ""}`,
  );
  writer.write(`  ${s.period.start} to ${s.period.end} (end exclusive)`);
  writer.write("");
  printTable(
    ["SOURCE", "GOVERNED ACTIONS", "UNITS"],
    [
      ...s.governedActions.bySource.map((r) => [
        r.source,
        String(r.actions),
        String(r.units),
      ]),
      [
        "total",
        String(s.governedActions.totalActions),
        String(s.governedActions.totalUnits),
      ],
    ],
    writer,
  );
  writer.write("");
  if (s.invoiceTotals.length === 0)
    writer.write("  No invoices in this period.");
  for (const t of s.invoiceTotals)
    writer.write(
      `  Invoices: ${t.invoices}, due ${money(t.dueMicros, t.currency)}, paid ${money(t.paidMicros, t.currency)}`,
    );
  writer.write(
    `  Usage credits: ${s.usageCredits.openingCredits} opening, ${s.usageCredits.closingCredits} closing`,
  );
  const failing = s.reconciliation.filter((c) => !c.holds).map((c) => c.id);
  writer.write(
    failing.length === 0
      ? "  Reconciliation: every check holds."
      : `  Reconciliation: does not hold: ${failing.join(", ")}.`,
  );
}

export async function billingStatement(
  opts: BillingStatementCliOptions,
  writer: CommandWriter = stdoutWriter,
  deps: BillingStatementDeps = defaultDeps,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  // ── Flags ───────────────────────────────────────────────────────────────
  const period = opts.period ?? "";
  if (!isPeriod(period)) {
    process.exitCode = 2;
    out.error(
      `Invalid --period "${period}". One of: ${PERIODS.join(", ")}.`,
      "usage",
    );
    return;
  }
  const format = opts.format ?? "summary";
  if (!isFormat(format)) {
    process.exitCode = 2;
    out.error(
      `Invalid --format "${format}". One of: ${FORMATS.join(", ")}.`,
      "usage",
    );
    return;
  }
  if (period === "custom" && (!opts.from || !opts.to)) {
    process.exitCode = 2;
    out.error(
      "--period custom needs --from and --to (RFC 3339), more than 48 hours apart.",
      "usage",
    );
    return;
  }
  if (period !== "custom" && (opts.from || opts.to)) {
    process.exitCode = 2;
    out.error(
      `--from and --to go with --period custom. For a ${period}, pass --anchor YYYY-MM-DD.`,
      "usage",
    );
    return;
  }
  const whole = (raw: string | undefined, flag: string, max: number) => {
    if (raw === undefined) return undefined;
    const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n > max) {
      process.exitCode = 2;
      out.error(
        `Invalid ${flag} "${raw}". Use a whole number from 1 to ${max}.`,
        "usage",
      );
      return null;
    }
    return n;
  };
  const top = whole(opts.top, "--top", 100);
  const pageSize = whole(opts.pageSize, "--page-size", 50_000);
  if (top === null || pageSize === null) return;

  const periodFields =
    period === "custom"
      ? { period, from: opts.from, to: opts.to }
      : { period, anchor: opts.anchor ?? deps.today() };

  // ── Summary ─────────────────────────────────────────────────────────────
  if (format === "summary") {
    let statement: StatementSummary;
    try {
      statement = await deps.post<StatementSummary>("billing/statement", {
        ...periodFields,
        ...(top === undefined ? {} : { top }),
      });
    } catch (err) {
      out.error(err, "api");
      return;
    }
    if (out.isJson) {
      out.data(statement);
      return;
    }
    renderSummary(statement, writer);
    return;
  }

  // ── Files ───────────────────────────────────────────────────────────────
  let cursor: string | null = null;
  let rows = 0;
  let filename = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let answer: ExportPage;
    try {
      answer = await deps.post<ExportPage>("billing/statement/export", {
        ...periodFields,
        format,
        ...(pageSize === undefined ? {} : { limit: pageSize }),
        ...(cursor === null ? {} : { cursor }),
      });
    } catch (err) {
      out.error(err, "api");
      if (opts.out && page > 0)
        out.warn(
          `${opts.out} holds the first ${rows} rows only. Run the command again for the whole file.`,
        );
      return;
    }
    filename = answer.filename;
    rows += answer.lines;
    if (opts.out) {
      if (page === 0) await deps.writeFile(opts.out, answer.content);
      else await deps.appendFile(opts.out, answer.content);
    } else {
      // The content already ends in a line break; the writer adds another.
      writer.write(answer.content.replace(/\r?\n$/, ""));
    }
    cursor = answer.nextCursor;
    if (cursor === null) break;
    out.info(`  ${rows} rows so far…`);
  }
  if (cursor !== null) {
    process.exitCode = 1;
    out.error(
      `Stopped after ${MAX_PAGES} pages. Export a shorter period, or raise --page-size.`,
      "api",
    );
    return;
  }
  if (opts.out)
    out.info(
      format === "csv"
        ? `✓ ${filename} written to ${opts.out}: ${rows} ledger rows.`
        : `✓ ${filename} written to ${opts.out}.`,
    );
}
