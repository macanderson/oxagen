#!/usr/bin/env tsx
/**
 * billing-statement — one organisation's billing statement, for a person at
 * Oxagen (ADR-158).
 *
 *   pnpm billing:statement --org acme --period month --anchor 2026-09-01 \
 *                          --format html --out ./statement.html
 *   pnpm billing:statement --org acme --period quarter --anchor 2026-07-01 --format json
 *   pnpm billing:statement --org acme --period custom \
 *                          --from 2026-09-01T00:00:00Z --to 2026-09-10T00:00:00Z \
 *                          --format csv --out ./acme-sept.csv
 *
 * The customer's own path is `export_billing_statement` (API, MCP, CLI and
 * the Billing page), which a platform operator cannot call: its handler
 * requires an Owner, Admin or Billing role in the organisation. This script
 * is the operator's path to the same document. It calls the same builder and
 * renderers in `@oxagen/billing` directly, inside an org-only tenant scope,
 * so the figures, the reference and the reconciliation checks are the ones
 * the customer sees.
 *
 * `--format csv` writes every ledger row of the period with no cap: it pages
 * the ledger 10,000 rows at a time on the (billed_at, id) keyset and appends
 * each page to `--out` as it arrives, so a year of millions of rows never
 * sits in memory at once. `html` and `json` write one document.
 *
 * The organisation is named by slug, because a slug is what a person has; the
 * lookup runs on withSystemDb, since the operator is not inside the tenant.
 * The script prints the target database host before it reads, because it is
 * run against production by hand and a shell DATABASE_URL beats --env-file.
 *
 * It writes no security event: the read goes through no capability, and the
 * security event types are a CHECK constraint a new type would have to be
 * migrated into. Who ran it is in the operator's shell history and the
 * database's own connection log.
 */
import { appendFile, writeFile } from "node:fs/promises";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import {
  buildBillingStatement,
  readStatementLineItems,
  renderLineItemsCsv,
  renderStatementCsv,
  renderStatementHtml,
  resolveStatementPeriod,
  type ResolvedStatementPeriod,
  type StatementLineItem,
} from "@oxagen/billing";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import type { BillingStatement } from "@oxagen/oxagen/contracts/billing.statement.get";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";

// ── Flags ─────────────────────────────────────────────────────────────────────

const PERIODS = ["week", "month", "quarter", "year", "custom"] as const;
type Period = (typeof PERIODS)[number];
const FORMATS = ["html", "csv", "json"] as const;
type Format = (typeof FORMATS)[number];

export interface BillingStatementFlags {
  orgSlug: string;
  period: Period;
  anchor?: string;
  from?: string;
  to?: string;
  format: Format;
  /** Absent: write to stdout. */
  out?: string;
}

const USAGE =
  "usage: pnpm billing:statement --org <slug> --period week|month|quarter|year --anchor YYYY-MM-DD [--format html|csv|json] [--out <file>]\n" +
  "       pnpm billing:statement --org <slug> --period custom --from <RFC 3339> --to <RFC 3339> [--format …] [--out <file>]";

/**
 * Parse the flags. The period's own rules (an anchor for a calendar period, a
 * range longer than 48 hours and at most 366 days for a custom one) are
 * `resolveStatementPeriod`'s, checked by the run, so this reads shapes only.
 */
export function parseFlags(argv: string[]): BillingStatementFlags {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (
      ![
        "--org",
        "--period",
        "--anchor",
        "--from",
        "--to",
        "--format",
        "--out",
      ].includes(arg)
    )
      throw new Error(`unknown flag: ${arg}\n${USAGE}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--"))
      throw new Error(`${arg} needs a value\n${USAGE}`);
    values.set(arg, next);
    i += 1;
  }
  const orgSlug = values.get("--org");
  if (!orgSlug) throw new Error(`--org is required\n${USAGE}`);
  const period = values.get("--period") ?? "";
  if (!(PERIODS as readonly string[]).includes(period))
    throw new Error(`--period must be one of ${PERIODS.join(", ")}\n${USAGE}`);
  const format = values.get("--format") ?? "html";
  if (!(FORMATS as readonly string[]).includes(format))
    throw new Error(`--format must be one of ${FORMATS.join(", ")}\n${USAGE}`);
  return {
    orgSlug,
    period: period as Period,
    anchor: values.get("--anchor"),
    from: values.get("--from"),
    to: values.get("--to"),
    format: format as Format,
    out: values.get("--out"),
  };
}

// ── The run ───────────────────────────────────────────────────────────────────

/** Ledger rows per read when writing the CSV. */
const PAGE_ROWS = 10_000;

interface BillingStatementDeps {
  resolveOrgId: (slug: string) => Promise<string | null>;
  /** Runs `fn` inside the organisation's org-only tenant scope. */
  inScope: <T>(orgId: string, fn: () => Promise<T>) => Promise<T>;
  build: (
    orgId: string,
    period: ResolvedStatementPeriod,
    opts: { now: Date },
  ) => Promise<BillingStatement>;
  lineItems: (
    orgId: string,
    period: ResolvedStatementPeriod,
    q: { cursor: string | null; limit: number },
  ) => Promise<{ items: StatementLineItem[]; nextCursor: string | null }>;
  /** Writes the first chunk (replacing any file) and appends the rest. */
  write: (chunk: string, first: boolean) => Promise<void>;
  now: () => Date;
}

export interface BillingStatementRun {
  reference: string;
  /** csv: ledger rows written. */
  rows: number;
  checksHeld: boolean;
}

/**
 * Resolve the slug and the period, build the statement in the org's scope,
 * and write the format. A CSV is written page by page as the ledger is read.
 */
export async function runBillingStatement(
  flags: BillingStatementFlags,
  deps: BillingStatementDeps,
): Promise<BillingStatementRun> {
  const orgId = await deps.resolveOrgId(flags.orgSlug);
  if (!orgId) throw new Error(`no organisation with slug "${flags.orgSlug}"`);
  const now = deps.now();
  const period = resolveStatementPeriod(
    {
      kind: flags.period,
      anchor: flags.anchor,
      from: flags.from,
      to: flags.to,
    },
    now,
  );

  return deps.inScope(orgId, async () => {
    const statement = await deps.build(orgId, period, { now });
    const checksHeld = statement.reconciliation.every((c) => c.holds);
    if (flags.format === "json") {
      await deps.write(`${JSON.stringify(statement, null, 2)}\n`, true);
      return { reference: statement.reference, rows: 0, checksHeld };
    }
    if (flags.format === "html") {
      await deps.write(renderStatementHtml(statement), true);
      return { reference: statement.reference, rows: 0, checksHeld };
    }
    let cursor: string | null = null;
    let rows = 0;
    let first = true;
    do {
      const page = await deps.lineItems(orgId, period, {
        cursor,
        limit: PAGE_ROWS,
      });
      await deps.write(
        first
          ? renderStatementCsv(statement, page.items)
          : renderLineItemsCsv(page.items),
        first,
      );
      first = false;
      rows += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return { reference: statement.reference, rows, checksHeld };
  });
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

/** Host and database of the target, with any credentials stripped. */
export function describeTarget(raw: string): string {
  try {
    const url = new URL(raw);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.hostname}:${url.port || "5432"}/${database}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const env = requireEnv(["DATABASE_URL"]);
  // Everything but the document goes to stderr, so `> file` captures only it.
  console.error(
    `  Target database: ${kleur.yellow(describeTarget(env.DATABASE_URL))}\n` +
      `  Organisation   : ${kleur.yellow(flags.orgSlug)}\n` +
      `  Period         : ${flags.period} ${flags.anchor ?? `${flags.from ?? ""} to ${flags.to ?? ""}`}\n` +
      `  Format         : ${flags.format}${flags.out ? ` → ${flags.out}` : " → stdout"}\n`,
  );

  const out = flags.out;
  const run = await runBillingStatement(flags, {
    resolveOrgId: async (slug) => {
      // tenancy: a global slug-to-orgId lookup, run before any tenant scope
      // exists; it reads one organizations row filtered by slug and returns
      // only its id. Every statement read after it is scoped to that orgId.
      const row = await withSystemDb((tx) =>
        tx.query.organizations.findFirst({
          where: eq(schema.organizations.slug, slug),
          columns: { id: true },
        }),
      );
      return row?.id ?? null;
    },
    inScope: (orgId, fn) =>
      runInTenantScope({ orgId, workspaceId: ORG_ONLY_WORKSPACE_ID }, fn),
    build: (orgId, period, opts) => buildBillingStatement(orgId, period, opts),
    lineItems: (orgId, period, q) => readStatementLineItems(orgId, period, q),
    write: async (chunk, first) => {
      if (!out) {
        process.stdout.write(chunk);
        return;
      }
      if (first) await writeFile(out, chunk, "utf8");
      else await appendFile(out, chunk, "utf8");
    },
    now: () => new Date(),
  });

  console.error(
    kleur.bold().cyan("  Statement:") +
      ` ${run.reference}${flags.format === "csv" ? `, ${run.rows} ledger rows` : ""}` +
      (run.checksHeld
        ? kleur.green(", every reconciliation check holds")
        : kleur.red(
            ", a reconciliation check does not hold: read the statement's Reconciliation section",
          )) +
      "\n",
  );
}

// Run only when invoked directly, so a test can import parseFlags and
// runBillingStatement without reading anything (the guard billing-terms.ts
// carries, for the same reason).
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error(
        kleur.red("\nbilling-statement failed:"),
        err instanceof Error ? err.message : err,
      );
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}
