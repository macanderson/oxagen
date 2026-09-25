// audit-exempt: read-only — builds the organization's monthly chargeback statement from cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `export_cost_center_statement` (ADR-142): one line per cost center for the
// month, and one for the spend no cost center claims, each with the run ids
// that make it up, then the organization total. The lines are built from the
// run rows, the record the daily cost_center level is folded from, so each
// line traces to the runs a finance reader can open, and every run lands on
// exactly one line at its full cost: the lines' micros sum to the total's.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import {
  COST_CENTER_STATEMENT_COLUMNS,
  COST_CENTER_STATEMENT_LINE_RUN_IDS_LIMIT,
  type CostCenterStatementLine,
  type spendCostCenterStatementExport,
  type SpendCostCenterStatementExportOutput,
} from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import {
  dayBounds,
  foldBasis,
  microsToCentsHalfEven,
  UNASSIGNED_COST_CENTER_KEY,
  type CostBasis,
  type RunTotalsRecord,
} from "@oxagen/billing";
import { schema, withOrgDb } from "@oxagen/database";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { cost } from "./spend.shared";
import { csvField, monthBounds } from "./spend.statement.export";

/** The columns of a run row the statement reads. The rest, `breakdown` included, it never needs. */
export type StatementRun = Pick<
  RunTotalsRecord,
  "runId" | "startedAt" | "costCenter" | "costMicros" | "costBasis" | "currency"
>;

/** The last run of the previous page. `startedAt` is RFC 3339 at millisecond precision. */
export interface StatementCursor {
  startedAt: string;
  runId: string;
}

/** How many run rows one page of the statement read holds. */
export const COST_CENTER_STATEMENT_PAGE_SIZE = 5_000;

export type CostCenterStatementDeps = {
  /**
   * One page of the organization's run rows, across its workspaces, that
   * started in [from, to]: oldest first by (startedAt, runId), after `after`
   * when given, at most `limit` rows.
   */
  readRunTotalsPage: (
    orgId: string,
    q: { from: string; to: string; limit: number; after?: StatementCursor },
  ) => Promise<StatementRun[]>;
  /** Rows per page, or {@link COST_CENTER_STATEMENT_PAGE_SIZE} when absent. */
  pageSize?: number;
};

const totals = schema.runTotals;

/** Who may read the organization-wide statement: the people accountable for the bill. */
const STATEMENT_READERS = { org: ["Owner", "Admin", "Billing"] } as const;

async function readOrgRunTotalsPage(
  orgId: string,
  q: { from: string; to: string; limit: number; after?: StatementCursor },
): Promise<StatementRun[]> {
  const { start } = dayBounds(q.from);
  const { next } = dayBounds(q.to);
  // The cursor travels at millisecond precision, so the order and the
  // comparison truncate the microseconds Postgres keeps, as
  // listRunsWithIncompleteCost does.
  const startedMs = sql<Date>`date_trunc('milliseconds', ${totals.startedAt})`;
  // An organization-wide read: withOrgDb widens the SELECT to every workspace
  // of the organization and RLS still fences org_id (ADR-086).
  const rows = await withOrgDb((tx) =>
    tx
      .select({
        runId: totals.runId,
        startedAt: totals.startedAt,
        costCenter: totals.costCenter,
        costMicros: totals.costMicros,
        costBasis: totals.costBasis,
        currency: totals.currency,
      })
      .from(totals)
      .where(
        and(
          eq(totals.orgId, orgId),
          gte(totals.startedAt, start),
          lt(totals.startedAt, next),
          q.after === undefined
            ? undefined
            : sql`(${startedMs}, ${totals.runId}) > (${q.after.startedAt}::timestamptz, ${q.after.runId})`,
        ),
      )
      .orderBy(asc(startedMs), asc(totals.runId))
      .limit(q.limit),
  );
  return rows.map((r) => ({
    ...r,
    costBasis: r.costBasis as CostBasis | null,
  }));
}

/**
 * Every run row of the month, page by page, handed to `visit` in store order.
 * No page is kept once visited, so the read holds one page at a time.
 */
async function forEachRun(
  deps: CostCenterStatementDeps,
  orgId: string,
  bounds: { from: string; to: string },
  visit: (run: StatementRun) => void,
): Promise<void> {
  const limit = deps.pageSize ?? COST_CENTER_STATEMENT_PAGE_SIZE;
  let after: StatementCursor | undefined;
  for (;;) {
    const page = await deps.readRunTotalsPage(orgId, {
      ...bounds,
      limit,
      after,
    });
    for (const run of page) visit(run);
    const last = page.at(-1);
    if (page.length < limit || last === undefined) return;
    // A store that ignored the cursor would hand back the same page for ever.
    if (after !== undefined && last.runId === after.runId)
      throw new Error(
        `export_cost_center_statement: run page did not advance past ${after.runId}`,
      );
    after = { startedAt: last.startedAt.toISOString(), runId: last.runId };
  }
}

interface LineAccumulator {
  runs: number;
  unpriced: number;
  micros: bigint | null;
  basis: CostBasis | null;
  /** The currency of the line's priced runs, null until one is priced. */
  currency: string | null;
  runIds: string[];
}

/**
 * Fold one run into a line or the total. Micros only add within one
 * currency, so a priced run in a currency other than the one the figure
 * already carries refuses the statement rather than sum across currencies
 * and label the sum with whichever came last. An unpriced run adds no
 * figure, so its currency is not checked.
 */
function accumulate(
  into: LineAccumulator,
  run: StatementRun,
  label: string,
): void {
  into.runs += 1;
  into.runIds.push(run.runId);
  if (run.costMicros === null || run.costBasis === null) {
    into.unpriced += 1;
    return;
  }
  if (into.currency !== null && into.currency !== run.currency)
    throw new HandlerError({
      code: "conflict",
      reason: "statement_mixed_currency",
      message: `The ${label} holds runs priced in ${into.currency} and in ${run.currency}. A statement figure sums one currency, so no statement was built.`,
    });
  into.currency = run.currency;
  into.micros = (into.micros ?? 0n) + run.costMicros;
  into.basis = foldBasis(into.basis, run.costBasis);
}

const empty = (): LineAccumulator => ({
  runs: 0,
  unpriced: 0,
  micros: null,
  basis: null,
  currency: null,
  runIds: [],
});

/** Largest cost first, unpriced lines after priced ones, the unassigned line last. */
function compareLines(
  a: CostCenterStatementLine,
  b: CostCenterStatementLine,
): number {
  const aNone = a.costCenter === UNASSIGNED_COST_CENTER_KEY;
  const bNone = b.costCenter === UNASSIGNED_COST_CENTER_KEY;
  if (aNone !== bNone) return aNone ? 1 : -1;
  const ac = a.cost === null ? null : BigInt(a.cost.micros);
  const bc = b.cost === null ? null : BigInt(b.cost.micros);
  if (ac !== null && bc !== null && ac !== bc) return ac > bc ? -1 : 1;
  if ((ac === null) !== (bc === null)) return ac === null ? 1 : -1;
  return a.costCenter < b.costCenter ? -1 : a.costCenter > b.costCenter ? 1 : 0;
}

function csvLine(
  line: "cost_center" | "total",
  key: string,
  runs: number,
  unpriced: number,
  figure: ReturnType<typeof cost>,
  runIds: readonly string[],
): string {
  const micros = figure === null ? null : BigInt(figure.micros);
  return [
    line,
    csvField(key),
    String(runs),
    String(unpriced),
    micros === null ? "" : micros.toString(),
    micros === null ? "" : microsToCentsHalfEven(micros).toString(),
    figure?.currency ?? "",
    figure?.basis ?? "",
    // Run ids carry no comma, quote or space, so one field holds them all.
    runIds.join(" "),
  ].join(",");
}

export function createCostCenterStatementHandler(
  deps: CostCenterStatementDeps,
): CapabilityHandler<typeof spendCostCenterStatementExport> {
  return async (input, ctx): Promise<SpendCostCenterStatementExportOutput> => {
    // The statement reads every workspace's spend, and the contract admits
    // Owner, Admin and Billing only. The kernel's IAM check fast-paths
    // non-enterprise humans, so the org role is enforced here (INV-29).
    const userId = await resolveActingUserId(ctx);
    await assertOrgRole({ ...ctx, userId }, STATEMENT_READERS);
    const byCenter = new Map<string, LineAccumulator>();
    const all = empty();
    await forEachRun(deps, ctx.orgId, monthBounds(input.month), (run) => {
      const key = run.costCenter ?? UNASSIGNED_COST_CENTER_KEY;
      const acc = byCenter.get(key) ?? empty();
      accumulate(acc, run, `cost center ${key}`);
      byCenter.set(key, acc);
      accumulate(all, run, "organization total");
    });
    // The CSV lists every run id. The data lists the oldest few per line and
    // counts the rest, so one response does not carry every id twice.
    const allRunIds = new Map<string, readonly string[]>();
    const lines: CostCenterStatementLine[] = [...byCenter.entries()]
      .map(([costCenter, acc]) => {
        allRunIds.set(costCenter, acc.runIds);
        const listed = acc.runIds.slice(
          0,
          COST_CENTER_STATEMENT_LINE_RUN_IDS_LIMIT,
        );
        return {
          costCenter,
          runs: acc.runs,
          unpricedRuns: acc.unpriced,
          cost: cost(acc.micros, acc.currency ?? "USD", acc.basis),
          runIds: listed,
          runIdsOmitted: acc.runIds.length - listed.length,
        };
      })
      .sort(compareLines);
    const total = {
      runs: all.runs,
      unpricedRuns: all.unpriced,
      cost: cost(all.micros, all.currency ?? "USD", all.basis),
    };
    const csv = [
      COST_CENTER_STATEMENT_COLUMNS.join(","),
      ...lines.map((l) =>
        csvLine(
          "cost_center",
          l.costCenter,
          l.runs,
          l.unpricedRuns,
          l.cost,
          allRunIds.get(l.costCenter) ?? [],
        ),
      ),
      // The total line lists no run ids: every one is on a line above it.
      csvLine("total", "", total.runs, total.unpricedRuns, total.cost, []),
    ];
    return {
      month: input.month,
      filename: `cost-center-statement-${input.month}.csv`,
      mediaType: "text/csv",
      content: `${csv.join("\n")}\n`,
      lines,
      total,
    };
  };
}

export const spendCostCenterStatementHandler = createCostCenterStatementHandler(
  { readRunTotalsPage: readOrgRunTotalsPage },
);
