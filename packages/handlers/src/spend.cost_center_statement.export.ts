// audit-exempt: read-only — builds the organization's monthly chargeback statement from cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `export_cost_center_statement` (ADR-142): one line per cost center for the
// month, and one for the spend no cost center claims, each with the run ids
// that make it up, then the organization total. The lines are built from the
// run rows, the record the daily cost_center level is folded from, so each
// line traces to the runs a finance reader can open, and every run lands on
// exactly one line at its full cost: the lines' micros sum to the total's.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  COST_CENTER_STATEMENT_COLUMNS,
  type CostCenterStatementLine,
  type spendCostCenterStatementExport,
  type SpendCostCenterStatementExportOutput,
} from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import {
  dayBounds,
  foldBasis,
  microsToCentsHalfEven,
  runTotalsRowToRecord,
  UNASSIGNED_COST_CENTER_KEY,
  type CostBasis,
  type RunTotalsRecord,
} from "@oxagen/billing";
import { schema, withOrgDb } from "@oxagen/database";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { cost } from "./spend.shared";
import { csvField, monthBounds } from "./spend.statement.export";

export type CostCenterStatementDeps = {
  /** Every run row of the organization, across its workspaces, that started in [from, to]. */
  readRunTotals: (
    orgId: string,
    q: { from: string; to: string },
  ) => Promise<RunTotalsRecord[]>;
};

const totals = schema.runTotals;

/** Who may read the organization-wide statement: the people accountable for the bill. */
const STATEMENT_READERS = { org: ["Owner", "Admin", "Billing"] } as const;

async function readOrgRunTotals(
  orgId: string,
  q: { from: string; to: string },
): Promise<RunTotalsRecord[]> {
  const { start } = dayBounds(q.from);
  const { next } = dayBounds(q.to);
  // An organization-wide read: withOrgDb widens the SELECT to every workspace
  // of the organization and RLS still fences org_id (ADR-086).
  const rows = await withOrgDb((tx) =>
    tx
      .select()
      .from(totals)
      .where(
        and(
          eq(totals.orgId, orgId),
          gte(totals.startedAt, start),
          lt(totals.startedAt, next),
        ),
      )
      .orderBy(asc(totals.startedAt), asc(totals.runId)),
  );
  return rows.map(runTotalsRowToRecord);
}

interface LineAccumulator {
  runs: number;
  unpriced: number;
  micros: bigint | null;
  basis: CostBasis | null;
  currency: string;
  runIds: string[];
}

function accumulate(into: LineAccumulator, run: RunTotalsRecord): void {
  into.runs += 1;
  into.runIds.push(run.runId);
  into.currency = run.currency;
  if (run.costMicros === null || run.costBasis === null) {
    into.unpriced += 1;
    return;
  }
  into.micros = (into.micros ?? 0n) + run.costMicros;
  into.basis = foldBasis(into.basis, run.costBasis);
}

const empty = (): LineAccumulator => ({
  runs: 0,
  unpriced: 0,
  micros: null,
  basis: null,
  currency: "USD",
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
    const runs = await deps.readRunTotals(ctx.orgId, monthBounds(input.month));
    const byCenter = new Map<string, LineAccumulator>();
    const all = empty();
    for (const run of runs) {
      const key = run.costCenter ?? UNASSIGNED_COST_CENTER_KEY;
      const acc = byCenter.get(key) ?? empty();
      accumulate(acc, run);
      byCenter.set(key, acc);
      accumulate(all, run);
    }
    const lines: CostCenterStatementLine[] = [...byCenter.entries()]
      .map(([costCenter, acc]) => ({
        costCenter,
        runs: acc.runs,
        unpricedRuns: acc.unpriced,
        cost: cost(acc.micros, acc.currency, acc.basis),
        runIds: acc.runIds,
      }))
      .sort(compareLines);
    const total = {
      runs: all.runs,
      unpricedRuns: all.unpriced,
      cost: cost(all.micros, all.currency, all.basis),
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
          l.runIds,
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
  { readRunTotals: readOrgRunTotals },
);
