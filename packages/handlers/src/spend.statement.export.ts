// audit-exempt: read-only — builds the workspace's monthly statement from cost.daily_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `export_statement` (ADR-060): one CSV line per group at every level for the
// month, cost in micros and, on that line, in cents rounded half to even
// once (spec §12.3). Proven and accepted spend stay apart (spec §12.8).
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  spendStatementExport,
  type SpendStatementExportOutput,
  STATEMENT_COLUMNS,
} from "@oxagen/oxagen/contracts/spend.statement.export";
import type { SpendGroupKind } from "@oxagen/oxagen/contracts/spend.shared";
import {
  microsToCentsHalfEven,
  type DailyTotalsRecord,
  utcDay,
} from "@oxagen/billing";
import { groupRows } from "./spend.get";
import { readDailyTotals, type SpendScope } from "./spend.shared";

export type SpendStatementDeps = {
  readDailyTotals: (
    scope: SpendScope,
    q: { from: string; to: string; groupKind: SpendGroupKind },
  ) => Promise<DailyTotalsRecord[]>;
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

export function createSpendStatementHandler(
  deps: SpendStatementDeps,
): CapabilityHandler<typeof spendStatementExport> {
  return async (input, ctx): Promise<SpendStatementExportOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = monthBounds(input.month);
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
});
