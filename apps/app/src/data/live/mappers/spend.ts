// The cost rollup's contract outputs to the Spend page's view models
// (ARCHITECTURE.md §3.4). Typed from each contract's `_output`, so a field the
// contract may leave null cannot land in a required view field. A cost is
// copied whole with the basis the rollup recorded; nothing here prices,
// rounds or fills a figure the contract did not carry. The one derived figure
// is Fleet's cache hit rate, a ratio of the token counts the rows carry.
import type { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import type { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import type { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import type { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import type { z } from "zod";
import type {
  FleetSpend,
  SpendBudgets,
  SpendDrill,
  SpendReport,
  SpendWaste,
} from "@/data/contracts/spend";
import type { ContractOutput } from "@/server/kernel";

type Figure = ContractOutput<typeof spendGet>["total"];

function toFigure(figure: Figure): z.input<typeof SpendReport>["total"] {
  return {
    cost: figure.cost,
    calls: figure.calls,
    runs: figure.runs,
    proven: figure.proven,
    accepted: figure.accepted,
    productiveRatio: figure.productiveRatio,
  };
}

export function toSpendReport(
  out: ContractOutput<typeof spendGet>,
): z.input<typeof SpendReport> {
  return {
    period: out.period,
    total: toFigure(out.total),
    rows: out.rows.map((row) => ({
      ...toFigure(row),
      key: row.key,
      provider: row.provider,
    })),
  };
}

/**
 * cache_read ÷ (input_uncached + cache_read) over every model row, the ratio
 * the mockup's Fleet tile names; null when the rows read no input token.
 */
export function toFleetSpend(
  out: ContractOutput<typeof spendGet>,
): z.input<typeof FleetSpend> {
  const cacheRead = out.rows.reduce((n, row) => n + row.tokens.cache_read, 0);
  const uncached = out.rows.reduce(
    (n, row) => n + row.tokens.input_uncached,
    0,
  );
  const input = cacheRead + uncached;
  return {
    period: out.period,
    spend: out.total.cost,
    cacheHitRate: input === 0 ? null : cacheRead / input,
  };
}

export function toSpendDrill(
  out: ContractOutput<typeof spendDrill>,
): z.input<typeof SpendDrill> {
  return {
    kind: out.kind,
    key: out.key,
    period: out.period,
    total: toFigure(out.total),
    series: out.series.map((day) => ({
      day: day.day,
      cost: day.cost,
      calls: day.calls,
      runs: day.runs,
    })),
    perCall: out.averages.perCall,
    perRun: out.averages.perRun,
    share: out.share,
    tools: out.byTool.map((tool) => ({
      name: tool.name,
      calls: tool.calls,
      runs: tool.runs,
    })),
  };
}

export function toSpendWaste(
  out: ContractOutput<typeof spendWasteList>,
): z.input<typeof SpendWaste> {
  return {
    wasted: out.wasted,
    share: out.share,
    runsWithWaste: out.runsWithWaste,
    largestCause: out.largestCause,
    causes: out.causes.map((cause) => ({
      cause: cause.cause,
      wasted: cause.wasted,
      runs: cause.runs,
      provingRuns: cause.runIds,
    })),
  };
}

export function toSpendBudgets(
  out: ContractOutput<typeof billingBudgetGet>,
): z.input<typeof SpendBudgets> {
  return out.budgets.map((budget) => ({
    scope: budget.scope,
    enabled: budget.enabled,
    period: budget.period,
    windowDays: budget.windowDays,
    limit: budget.limit,
    spent: budget.spent,
    ratio: budget.ratio,
    state: budget.state,
  }));
}
