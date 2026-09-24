// The cost rollup's contract outputs to the Spend page's view models
// (ARCHITECTURE.md §3.4). Typed from each contract's `_output`, so a field the
// contract may leave null cannot land in a required view field. A cost is
// copied whole with the basis the rollup recorded; nothing here prices,
// rounds or fills a figure the contract did not carry. The one derived figure
// is Fleet's cache hit rate, a ratio of the token counts the rows carry.
import type { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import type { tachoSessionPolicyRead } from "@oxagen/oxagen/contracts/tacho.session_policy.read";
import type { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import type { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import type { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import type { findingList } from "@oxagen/oxagen/contracts/finding.list";
import type { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import type { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import type { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import type { z } from "zod";
import type {
  FleetSpend,
  GatewayPolicy,
  PriceBook,
  SpendBudgets,
  SpendDrill,
  SpendFinding,
  SpendFindingEvidence,
  SpendFindings,
  SpendReport,
  SpendWaste,
  UnpricedModels,
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
    estimatedRuns: out.estimatedRuns,
    rows: out.rows.map((row) => ({
      ...toFigure(row),
      key: row.key,
      provider: row.provider,
      tokens: row.tokens,
      operator: row.operator,
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

type FindingOut = ContractOutput<typeof findingList>["findings"][number];

/**
 * One finding as the page reads it. The saving and its basis are the findings
 * job's, copied whole; the decision fields the contract also carries are not
 * read here, since the section lists open findings alone.
 */
function toFinding(finding: FindingOut): z.input<typeof SpendFinding> {
  return {
    id: finding.id,
    kind: finding.kind,
    level: finding.level,
    subject: finding.subject,
    saving: finding.saving,
    confidence: finding.confidence,
    window: finding.window,
    why: finding.why,
    fix: finding.fix,
    runs: finding.runs,
    calls: finding.calls,
  };
}

export function toSpendFindings(
  out: ContractOutput<typeof findingList>,
): z.input<typeof SpendFindings> {
  return {
    window: out.window,
    saving: out.saving,
    spend: out.spend,
    share: out.share,
    annualised: out.annualised,
    counts: {
      findings: out.counts.findings,
      high: out.counts.high,
      medium: out.counts.medium,
      operators: out.counts.operators,
    },
    findings: out.findings.map(toFinding),
  };
}

export function toSpendFindingEvidence(
  out: ContractOutput<typeof findingEvidenceGet>,
): z.input<typeof SpendFindingEvidence> {
  return {
    finding: toFinding(out.finding),
    calls: out.evidence.calls,
    coveredCalls: out.evidence.coveredCalls,
    measuredTokens: out.evidence.measuredTokens,
    counterfactualTokens: out.evidence.counterfactualTokens,
    measured: out.evidence.measured,
    counterfactual: out.evidence.counterfactual,
    runs: out.evidence.runs.map((run) => ({
      runId: run.runId,
      startedAt: run.startedAt,
      calls: run.calls,
      measuredTokens: run.measuredTokens,
      counterfactualTokens: run.counterfactualTokens,
      measured: run.measured,
      counterfactual: run.counterfactual,
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

/**
 * The wrapped-session policy as the page reads it: the contract's own shape,
 * unchanged. There is nothing to derive, and `modelAllow` keeps its null —
 * flattening it to `[]` here would turn "permit every model" into "permit
 * none" on the way to the page.
 */
export function toGatewayPolicy(
  out: ContractOutput<typeof tachoSessionPolicyRead>,
): z.input<typeof GatewayPolicy> {
  return {
    mode: out.mode,
    // The contract states the ceiling in whole dollars; the page prints every
    // figure through <Money>, which reads micros. Both are carried so the
    // dialog's field and the printed amount come from one read.
    sessionLimit:
      out.sessionLimitUsd === null
        ? null
        : {
            micros: String(Math.round(out.sessionLimitUsd * 1_000_000)),
            currency: "USD",
          },
    sessionLimitUsd: out.sessionLimitUsd,
    modelAllow: out.modelAllow,
    modelDeny: out.modelDeny,
  };
}

/**
 * The price book as the page reads it. The rate is the micros the contract
 * carried, wrapped in the row's own currency so the page prints it through
 * <Money> like every other figure; `negotiated` is the one derived field, and
 * it is `orgId !== null` — the same test the resolver makes when it picks this
 * row over the list one. The entry id is dropped: nothing on the page
 * addresses a row by it (INV-11).
 */
export function toPriceBook(
  out: ContractOutput<typeof costPriceEntryList>,
): z.input<typeof PriceBook> {
  return {
    at: out.at,
    entries: out.entries.map((entry) => ({
      ...(entry.cancellationToken === undefined
        ? {}
        : { cancellationToken: entry.cancellationToken }),
      provider: entry.provider,
      model: entry.model,
      modelAliases: entry.modelAliases,
      region: entry.region,
      tokenClass: entry.tokenClass,
      unit: entry.unit,
      ratePerMillion: {
        micros: entry.microsPerMillion,
        currency: entry.currency,
      },
      effectiveFrom: entry.effectiveFrom,
      effectiveTo: entry.effectiveTo,
      source: entry.source,
      negotiated: entry.orgId !== null,
    })),
  };
}

export function toUnpricedModels(
  out: ContractOutput<typeof costUnpricedModelList>,
): z.input<typeof UnpricedModels> {
  return {
    since: out.since,
    at: out.at,
    models: out.models.map((model) => ({
      model: model.model,
      provider: model.provider,
      calls: model.calls,
      tokens: model.tokens,
      firstSeen: model.firstSeen,
      lastSeen: model.lastSeen,
      missingClasses: model.missingClasses,
      fullyUnpriced: model.fullyUnpriced,
    })),
  };
}
