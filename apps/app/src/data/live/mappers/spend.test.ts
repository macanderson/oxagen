// The spend mappers over real contract outputs: each sample is parsed by the
// contract's own output schema first, and each mapped value by the view model,
// so neither a sample the contract would refuse nor a view the page would
// refuse can make a test pass.
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { describe, expect, it } from "vitest";
import {
  FleetSpend,
  PriceBook,
  SpendBudgets,
  SpendDrill,
  SpendFindingEvidence,
  SpendFindings,
  SpendReport,
  SpendWaste,
  UnpricedModels,
} from "@/data/contracts/spend";
import {
  toFleetSpend,
  toPriceBook,
  toSpendBudgets,
  toSpendDrill,
  toSpendFindingEvidence,
  toSpendFindings,
  toSpendReport,
  toSpendWaste,
  toUnpricedModels,
} from "./spend";

const tokens = {
  input_uncached: 1200,
  cache_read: 800,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 300,
  reasoning: 0,
};
/**
 * The same counts as `get_spend` answers them. The page's view leaves out
 * `server_tool_request`.
 */
const wireTokens = { ...tokens, server_tool_request: 0 };
const priced = {
  micros: "12345678",
  currency: "USD",
  basis: "mixed",
} as const;

const figure = {
  cost: priced,
  calls: 40,
  runs: 12,
  proven: null,
  accepted: { micros: "2000000", currency: "USD" },
  productiveRatio: null,
};

describe("toSpendReport", () => {
  it("copies the total and each group with the basis the rollup recorded, and keeps an unpriced group null", () => {
    const out = spendGet.output.parse({
      period: { from: "2026-09-01", to: "2026-09-15" },
      groupBy: "model",
      total: figure,
      rows: [
        {
          ...figure,
          key: "claude-sonnet-5",
          provider: "anthropic",
          operator: null,
          tokens: wireTokens,
        },
        {
          ...figure,
          cost: null,
          accepted: null,
          key: "unpriced-model",
          provider: null,
          operator: null,
          tokens: wireTokens,
        },
      ],
    });
    const view = SpendReport.parse(toSpendReport(out));
    expect(view.total).toEqual(figure);
    expect(view.rows[0]?.tokens).toEqual(tokens);
    expect(view.rows.map((row) => [row.key, row.provider, row.cost])).toEqual([
      ["claude-sonnet-5", "anthropic", priced],
      ["unpriced-model", null, null],
    ]);
    expect(view.rows[1]?.accepted).toBeNull();
    expect(view.rows[0]?.proven).toBeNull();
  });
});

describe("toFleetSpend", () => {
  const day = { from: "2026-09-15", to: "2026-09-15" };

  it("copies the day's cost with its basis and divides cache reads by every input token over the model rows", () => {
    const out = spendGet.output.parse({
      period: day,
      groupBy: "model",
      total: figure,
      rows: [
        {
          ...figure,
          key: "claude-sonnet-5",
          provider: "anthropic",
          operator: null,
          tokens: wireTokens,
        },
        {
          ...figure,
          key: "claude-haiku-5",
          provider: "anthropic",
          operator: null,
          tokens: { ...wireTokens, input_uncached: 800, cache_read: 1200 },
        },
      ],
    });
    expect(FleetSpend.parse(toFleetSpend(out))).toEqual({
      period: day,
      spend: priced,
      cacheHitRate: 0.5,
    });
  });

  it("answers a null rate for a day with no input token and keeps an unpriced day null, never a zero (negative)", () => {
    const out = spendGet.output.parse({
      period: day,
      groupBy: "model",
      total: { ...figure, cost: null, calls: 0, runs: 0, accepted: null },
      rows: [],
    });
    expect(FleetSpend.parse(toFleetSpend(out))).toEqual({
      period: day,
      spend: null,
      cacheHitRate: null,
    });
  });
});

describe("toSpendDrill", () => {
  it("keeps the series, the averages and a tool drill's unpriced money as null", () => {
    const out = spendDrill.output.parse({
      kind: "tool",
      key: "github__create_pull_request",
      period: { from: "2026-08-17", to: "2026-09-15" },
      total: { ...figure, cost: null, accepted: null },
      series: [
        { day: "2026-09-14", cost: null, calls: 3, runs: 1 },
        { day: "2026-09-15", cost: null, calls: 0, runs: 0 },
      ],
      averages: { perCall: null, perRun: null },
      share: null,
      byTool: [{ name: "github__create_pull_request", calls: 3, runs: 1 }],
    });
    const view = SpendDrill.parse(toSpendDrill(out));
    expect(view).toMatchObject({
      kind: "tool",
      key: "github__create_pull_request",
      perCall: null,
      perRun: null,
      share: null,
      tools: [{ name: "github__create_pull_request", calls: 3, runs: 1 }],
    });
    expect(view.series.map((d) => [d.day, d.cost])).toEqual([
      ["2026-09-14", null],
      ["2026-09-15", null],
    ]);
  });

  it("carries an operator's averages in micros", () => {
    const out = spendDrill.output.parse({
      kind: "operator",
      key: "prn_marcusbell",
      period: { from: "2026-08-17", to: "2026-09-15" },
      total: figure,
      series: [],
      averages: {
        perCall: { micros: "4200", currency: "USD" },
        perRun: { micros: "1028806", currency: "USD" },
      },
      share: 0.31,
      byTool: [],
    });
    const view = SpendDrill.parse(toSpendDrill(out));
    expect(view.perCall).toEqual({ micros: "4200", currency: "USD" });
    expect(view.perRun).toEqual({ micros: "1028806", currency: "USD" });
    expect(view.share).toBe(0.31);
  });
});

describe("toSpendWaste", () => {
  it("names each cause's proving runs by their public ids", () => {
    const out = spendWasteList.output.parse({
      period: { from: "2026-09-01", to: "2026-09-15" },
      wasted: { micros: "900000", currency: "USD", basis: "gateway_observed" },
      share: 0.07,
      runsWithWaste: 2,
      largestCause: "cache_write_never_read",
      causes: [
        {
          cause: "cache_write_never_read",
          wasted: {
            micros: "900000",
            currency: "USD",
            basis: "gateway_observed",
          },
          runs: 2,
          runIds: ["arun_01k5rn8f3j", "tse_01k5rn9t4"],
        },
      ],
    });
    const view = SpendWaste.parse(toSpendWaste(out));
    expect(view.causes[0]?.provingRuns).toEqual([
      "arun_01k5rn8f3j",
      "tse_01k5rn9t4",
    ]);
    expect(view.wasted?.basis).toBe("gateway_observed");
  });

  it("keeps a period with no waste null rather than zero", () => {
    const out = spendWasteList.output.parse({
      period: { from: "2026-09-01", to: "2026-09-15" },
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: null,
      causes: [],
    });
    expect(SpendWaste.parse(toSpendWaste(out))).toEqual({
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: null,
      causes: [],
    });
  });
});

describe("toSpendBudgets", () => {
  it("keeps the ceiling, the burn and its position", () => {
    const out = billingBudgetGet.output.parse({
      budgets: [
        {
          scope: "workspace",
          publicId: "sbud_core",
          enabled: true,
          period: "rolling",
          windowDays: 7,
          limit: { micros: "500000000", currency: "USD" },
          spent: { micros: "410000000", currency: "USD" },
          projected: { micros: "410000000", currency: "USD" },
          ratio: 0.82,
          state: "threshold_80",
          reachedThreshold: 80,
          windowStart: "2026-09-08T00:00:00.000Z",
          windowEnd: "2026-09-15T00:00:00.000Z",
        },
      ],
    });
    expect(SpendBudgets.parse(toSpendBudgets(out))).toEqual([
      {
        scope: "workspace",
        enabled: true,
        period: "rolling",
        windowDays: 7,
        limit: { micros: "500000000", currency: "USD" },
        spent: { micros: "410000000", currency: "USD" },
        ratio: 0.82,
        state: "threshold_80",
      },
    ]);
  });
});

describe("toSpendFindings", () => {
  const saving = {
    micros: "984600000",
    currency: "USD",
    basis: "gateway_observed",
  } as const;
  const listedFinding = {
    id: "fnd_01k5rtgh",
    kind: "unpaged_results",
    level: "tool",
    subject: "aws_billing__get_cost_and_usage",
    saving,
    confidence: "high",
    window: {
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-09-15T00:00:00.000Z",
    },
    why: "Each run requests thirty days of line items unpaged.",
    fix: "Request grouped totals; page line items only on drill-down.",
    runs: 88,
    calls: 3106,
    status: "open",
    detectedAt: "2026-09-15T02:00:00.000Z",
    decidedAt: null,
    appliedActionId: null,
  };

  it("copies the totals and every finding with the basis the job recorded", () => {
    const out = findingList.output.parse({
      status: "open",
      window: listedFinding.window,
      saving,
      spend: { micros: "18402660000", currency: "USD", basis: "mixed" },
      share: 0.64,
      annualised: { ...saving, micros: "17649600000" },
      counts: { findings: 1, high: 1, medium: 0, operators: 3 },
      findings: [listedFinding],
    });
    const view = SpendFindings.parse(toSpendFindings(out));
    expect(view.saving).toEqual(saving);
    expect(view.spend?.basis).toBe("mixed");
    expect(view.share).toBe(0.64);
    expect(view.counts).toEqual({
      findings: 1,
      high: 1,
      medium: 0,
      operators: 3,
    });
    expect(view.findings[0]).toEqual({
      id: "fnd_01k5rtgh",
      kind: "unpaged_results",
      level: "tool",
      subject: "aws_billing__get_cost_and_usage",
      saving,
      confidence: "high",
      window: listedFinding.window,
      why: listedFinding.why,
      fix: listedFinding.fix,
      runs: 88,
      calls: 3106,
    });
  });

  it("keeps a window, a saving and a spend the contract left null null", () => {
    const out = findingList.output.parse({
      status: "open",
      window: null,
      saving: null,
      spend: null,
      share: null,
      annualised: null,
      counts: { findings: 0, high: 0, medium: 0, operators: 0 },
      findings: [],
    });
    const view = SpendFindings.parse(toSpendFindings(out));
    expect(view).toEqual({
      window: null,
      saving: null,
      spend: null,
      share: null,
      annualised: null,
      counts: { findings: 0, high: 0, medium: 0, operators: 0 },
      findings: [],
    });
  });

  it("copies one finding's arithmetic and the runs it cites", () => {
    const out = findingEvidenceGet.output.parse({
      finding: listedFinding,
      evidence: {
        calls: 3106,
        coveredCalls: 2980,
        measuredTokens: 41200,
        counterfactualTokens: 1900,
        measured: { micros: "1030400000", currency: "USD" },
        counterfactual: { micros: "45800000", currency: "USD" },
        runs: [
          {
            runId: "arun_01k5rn8f3j",
            startedAt: "2026-09-11T06:00:00.000Z",
            calls: 36,
            measuredTokens: 41200,
            counterfactualTokens: 1900,
            measured: { micros: "24100000", currency: "USD" },
            counterfactual: { micros: "1120000", currency: "USD" },
          },
        ],
      },
    });
    const view = SpendFindingEvidence.parse(toSpendFindingEvidence(out));
    expect(view.finding.id).toBe("fnd_01k5rtgh");
    expect(view.coveredCalls).toBe(2980);
    expect(view.measured).toEqual({ micros: "1030400000", currency: "USD" });
    expect(view.runs).toEqual([
      {
        runId: "arun_01k5rn8f3j",
        startedAt: "2026-09-11T06:00:00.000Z",
        calls: 36,
        measuredTokens: 41200,
        counterfactualTokens: 1900,
        measured: { micros: "24100000", currency: "USD" },
        counterfactual: { micros: "1120000", currency: "USD" },
      },
    ]);
  });
});

describe("toPriceBook", () => {
  const listRow = {
    id: "9f1b7a2c-0000-4000-8000-000000000001",
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: ["claude-sonnet-5-20260401"],
    region: null,
    tokenClass: "output",
    unit: "token",
    currency: "USD",
    microsPerMillion: "15000000",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    source: "list",
  };

  it("reads the micros as money and drops the database row id", () => {
    const out = costPriceEntryList.output.parse({
      at: "2026-09-15T12:00:00.000Z",
      entries: [listRow],
    });
    const view = PriceBook.parse(toPriceBook(out));
    expect(view.entries[0]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      modelAliases: ["claude-sonnet-5-20260401"],
      region: null,
      tokenClass: "output",
      unit: "token",
      ratePerMillion: { micros: "15000000", currency: "USD" },
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      source: "list",
      negotiated: false,
    });
    expect(view.entries[0]).not.toHaveProperty("id");
    expect(view.entries[0]).not.toHaveProperty("orgId");
  });

  it("marks a row this organization owns as its own, which is what beats the list price", () => {
    const out = costPriceEntryList.output.parse({
      at: "2026-09-15T12:00:00.000Z",
      entries: [
        {
          ...listRow,
          orgId: "7a000000-0000-4000-8000-0000000000a1",
          microsPerMillion: "2400000",
          source: "negotiated",
        },
      ],
    });
    const view = PriceBook.parse(toPriceBook(out));
    expect(view.entries[0]?.negotiated).toBe(true);
    expect(view.entries[0]?.ratePerMillion.micros).toBe("2400000");
  });
});

describe("toUnpricedModels", () => {
  it("copies the window, the counts and the classes the book cannot price", () => {
    const out = costUnpricedModelList.output.parse({
      since: "2026-08-16T00:00:00.000Z",
      at: "2026-09-15T12:00:00.000Z",
      models: [
        {
          model: "acme-internal-7b",
          provider: null,
          calls: 1240,
          tokens: 9400000,
          firstSeen: "2026-08-20T00:00:00.000Z",
          lastSeen: "2026-09-15T00:00:00.000Z",
          missingClasses: ["input_uncached", "output"],
          missingClassWindows: [
            {
              tokenClass: "input_uncached",
              unpricedFrom: "2026-08-20T00:00:00.000Z",
              unpricedTo: "2026-09-15T00:00:00.000Z",
              calls: 0,
              units: 0,
            },
            {
              tokenClass: "output",
              unpricedFrom: "2026-08-20T00:00:00.000Z",
              unpricedTo: "2026-09-15T00:00:00.000Z",
              calls: 0,
              units: 0,
            },
          ],
          fullyUnpriced: true,
        },
      ],
    });
    const view = UnpricedModels.parse(toUnpricedModels(out));
    expect(view).toEqual({
      since: "2026-08-16T00:00:00.000Z",
      at: "2026-09-15T12:00:00.000Z",
      models: [
        {
          model: "acme-internal-7b",
          provider: null,
          calls: 1240,
          tokens: 9400000,
          firstSeen: "2026-08-20T00:00:00.000Z",
          lastSeen: "2026-09-15T00:00:00.000Z",
          missingClasses: ["input_uncached", "output"],
          fullyUnpriced: true,
        },
      ],
    });
  });
});
