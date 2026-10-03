// audit-exempt: read-only — builds the workspace's monthly statement from cost.daily_totals, or its run lines from cost.run_totals with each run's operator and work item; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `export_statement` (ADR-060): one CSV line per group at every level for the
// month, cost in micros and, on that line, in cents rounded half to even
// once (spec §12.3). Proven and accepted spend stay apart (spec §12.8).
//
// With `rows: "runs"`, one line per run that started in the month (#2962):
// its agent, its operator, the work item it served, and its cost. A run no
// frame priced leaves its cost empty, never 0. The in-app assistant's runs
// share one line that names no run (ADR-235), so the lines add up to the
// month's total.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_STATEMENT_COLUMNS,
  spendStatementExport,
  type SpendStatementExportOutput,
  STATEMENT_COLUMNS,
} from "@oxagen/oxagen/contracts/spend.statement.export";
import type {
  Cost,
  SpendGroupKind,
} from "@oxagen/oxagen/contracts/spend.shared";
import {
  microsToCentsHalfEven,
  type DailyTotalsRecord,
  utcDay,
} from "@oxagen/billing";
import {
  readOperatorFacts,
  type ReadOperatorFacts,
} from "./lib/operator-facts";
import {
  type ReadRunWorkItems,
  readRunWorkItems,
  type RunWorkOrderRef,
  workOrderKey,
} from "./lib/run-work-items";
import { groupRows } from "./spend.get";
import {
  cost,
  readDailyTotals,
  readRunTotals,
  runFigure,
  type SpendRunRecord,
  type SpendScope,
  sumFigures,
} from "./spend.shared";

export type SpendStatementDeps = {
  readDailyTotals: (
    scope: SpendScope,
    q: { from: string; to: string; groupKind: SpendGroupKind },
  ) => Promise<DailyTotalsRecord[]>;
  /** The month's run rows, oldest first, for the file with one line per run. */
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string },
  ) => Promise<SpendRunRecord[]>;
  /** Who each operator key names. */
  readOperatorFacts: ReadOperatorFacts;
  /** The work item each run's work order served. */
  readRunWorkItems: ReadRunWorkItems;
};

const LEVELS: readonly SpendGroupKind[] = [
  "operator",
  "agent",
  "model",
  "tool",
  "task",
  "cost_center",
];

/** The first and last day of a `YYYY-MM` month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const from = `${month}-01`;
  const to = utcDay(new Date(Date.UTC(y, m, 0)));
  return { from, to };
}

/** RFC 4180: quote a field that holds a comma, a quote or a line break. */
export function csvField(value: string | null): string {
  if (value === null) return "";
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A field of free text that came from a person or a tracker, such as a work
 * item's title. A spreadsheet runs a cell that starts with `=`, `+`, `-`, `@`,
 * a tab, or a carriage return as a formula, so such a value gets a leading
 * `'` and stays text (OWASP, CSV injection). Then RFC 4180 quoting applies.
 */
export function csvText(value: string | null): string {
  if (value === null) return "";
  return csvField(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
}

/** The cost columns of one line: micros, cents rounded once, currency, basis. */
function costFields(figure: Cost | null): string[] {
  if (figure === null) return ["", "", "", ""];
  const micros = BigInt(figure.micros);
  return [
    micros.toString(),
    microsToCentsHalfEven(micros).toString(),
    figure.currency,
    figure.basis,
  ];
}

/** A run's work order, when the rollup resolved one. */
function workOrderOf(run: SpendRunRecord): RunWorkOrderRef | null {
  const id = run.workOrderId ?? null;
  const kind = run.workOrderKind ?? null;
  return id === null || kind === null
    ? null
    : { workOrderId: id, workOrderKind: kind };
}

/**
 * The file with one line per run: the month's runs oldest first, then one
 * line for the in-app assistant's runs when the month has any. A run line's
 * operator is the person's name, empty when nobody can name them, and never
 * the key in its place. Its work item is empty when its work order has none.
 */
export async function runStatementLines(
  deps: Omit<SpendStatementDeps, "readDailyTotals">,
  scope: SpendScope,
  range: { from: string; to: string },
): Promise<string[]> {
  const runs = await deps.readRunTotals(scope, range);
  const own = runs.filter((run) => run.inApp !== true);
  const inApp = runs.filter((run) => run.inApp === true);
  const orders = own.flatMap((run) => {
    const order = workOrderOf(run);
    return order === null ? [] : [order];
  });
  const [facts, items] = await Promise.all([
    deps.readOperatorFacts(
      scope,
      own.flatMap((run) => (run.operatorKey === null ? [] : [run.operatorKey])),
    ),
    deps.readRunWorkItems(scope, orders),
  ]);
  const lines = own.map((run) => {
    const order = workOrderOf(run);
    const item = order === null ? undefined : items.get(workOrderKey(order));
    const operator =
      run.operatorKey === null ? undefined : facts.get(run.operatorKey);
    return [
      "run",
      csvField(run.runId),
      run.startedAt.toISOString(),
      run.sealedAt === null ? "" : run.sealedAt.toISOString(),
      csvField(run.agentKey),
      csvField(run.operatorKey),
      csvText(operator?.name ?? null),
      csvText(item?.number ?? null),
      csvText(item?.subject ?? null),
      "1",
      ...costFields(cost(run.costMicros, run.currency, run.costBasis)),
    ].join(",");
  });
  if (inApp.length > 0) {
    const figure = sumFigures(inApp.map(runFigure));
    lines.push(
      [
        "assistant",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        String(figure.runs),
        ...costFields(figure.cost),
      ].join(","),
    );
  }
  return lines;
}

export function createSpendStatementHandler(
  deps: SpendStatementDeps,
): CapabilityHandler<typeof spendStatementExport> {
  return async (input, ctx): Promise<SpendStatementExportOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = monthBounds(input.month);
    if (input.rows === "runs") {
      const runLines = await runStatementLines(deps, scope, { from, to });
      const header = RUN_STATEMENT_COLUMNS.join(",");
      return {
        month: input.month,
        filename: `spend-runs-${input.month}.csv`,
        mediaType: "text/csv",
        content: `${[header, ...runLines].join("\n")}\n`,
        lines: runLines.length,
      };
    }
    const lines: string[] = [STATEMENT_COLUMNS.join(",")];
    let count = 0;
    for (const level of LEVELS) {
      const rows = groupRows(
        await deps.readDailyTotals(scope, { from, to, groupKind: level }),
      );
      for (const row of rows) {
        const micros = row.cost === null ? null : BigInt(row.cost.micros);
        lines.push(
          [
            level,
            csvField(row.key),
            csvField(row.provider),
            String(row.runs),
            String(row.calls),
            micros === null ? "" : micros.toString(),
            micros === null ? "" : microsToCentsHalfEven(micros).toString(),
            row.cost?.currency ?? "",
            row.cost?.basis ?? "",
            row.proven?.micros ?? "",
            row.accepted?.micros ?? "",
          ].join(","),
        );
        count += 1;
      }
    }
    return {
      month: input.month,
      filename: `spend-statement-${input.month}.csv`,
      mediaType: "text/csv",
      content: `${lines.join("\n")}\n`,
      lines: count,
    };
  };
}

export const spendStatementHandler = createSpendStatementHandler({
  readDailyTotals,
  readRunTotals: (scope, q) =>
    readRunTotals(scope, { ...q, filter: { kind: "all" } }),
  readOperatorFacts,
  readRunWorkItems,
});
