import { describe, expect, it } from "vitest";
import {
  OPERATOR_METRIC_DEFINITIONS,
  spendWorkOrderMetrics,
  UNASSIGNED_SPEND_DEFINITION,
  WORK_ORDER_METRIC_DEFINITIONS,
  WORK_ORDER_METRICS_WEEKS_MAX,
} from "./spend.work_order_metrics";

const usd = (micros: string) => ({ micros, currency: "USD" });
const RUN = "tse_0000000000000000000001";

const rate = (value: number | null, numerator: number, denominator: number) => ({
  value,
  numerator,
  denominator,
  workOrders: [],
  runs: [],
});

const workOrders = {
  done: 1,
  doneRate: rate(1, 1, 1),
  firstPassRate: rate(1, 1, 1),
  costToDone: { value: usd("400"), workOrders: ["wo_one"], runs: [RUN] },
  timeToDone: { valueMs: 3_600_000, workOrders: ["wo_one"], runs: [] },
  reworkSpend: { value: usd("0"), workOrders: [], runs: [] },
  abandonedSpend: { value: usd("0"), workOrders: [], runs: [] },
  reopenRate: { ...rate(0, 0, 1), pending: 1 },
};

const unassigned = {
  spend: usd("600"),
  tokens: 3000,
  share: 0.6,
  runs: [{ runId: RUN, unassigned: usd("600") }],
};

const week = {
  week: { from: "2026-09-28", to: "2026-10-04" },
  settled: true,
  workspace: {
    spend: usd("1000"),
    unproductive: usd("100"),
    unassigned,
    notRecorded: usd("0"),
    workOrders,
  },
  operators: [
    {
      operator: { kind: "named", key: "prn_ana", facts: null },
      metrics: {
        doneWorkOrders: { value: 1, workOrders: ["wo_one"], runs: [RUN] },
        costPerDone: { value: usd("400"), workOrders: [], runs: [] },
        unproductiveShare: { value: 0.1, runs: [RUN] },
        agentsInFlight: { value: 0.5, agents: ["acme.web.fixer"] },
        leverage: { value: 2 },
        touchesPerDone: { value: 3, touches: 3, basis: "interrupts", runs: [RUN] },
        unassignedShare: { value: 0.6, runs: [RUN] },
      },
      unassigned,
      workOrders,
    },
  ],
  agents: [{ agentKey: "acme.web.fixer", unassigned, workOrders }],
};

const answer = {
  period: { from: "2026-09-28", to: "2026-10-04" },
  pseudonyms: false,
  currency: "USD",
  definitions: {
    operator: [...OPERATOR_METRIC_DEFINITIONS],
    workOrder: [...WORK_ORDER_METRIC_DEFINITIONS],
    unassigned: UNASSIGNED_SPEND_DEFINITION,
  },
  weeks: [week],
};

describe("get_work_order_metrics contract", () => {
  it("is a manager read: the answer names operators", () => {
    expect(spendWorkOrderMetrics.name).toBe("get_work_order_metrics");
    expect(spendWorkOrderMetrics.mutates).toBe(false);
    expect(spendWorkOrderMetrics.noBillingGate).toBe(true);
    expect(spendWorkOrderMetrics.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("defines the seven operator metrics and the seven work order metrics the spec lists", () => {
    expect(OPERATOR_METRIC_DEFINITIONS.map((d) => d.name)).toEqual([
      "Done work orders",
      "Cost per done",
      "Unproductive share",
      "Agents in flight",
      "Leverage",
      "Touches per done",
      "Unassigned share",
    ]);
    expect(WORK_ORDER_METRIC_DEFINITIONS.map((d) => d.name)).toEqual([
      "Done rate",
      "First-pass rate",
      "Cost to done",
      "Time to done",
      "Rework spend",
      "Abandoned spend",
      "Reopen rate",
    ]);
    const ids = [
      ...OPERATOR_METRIC_DEFINITIONS,
      ...WORK_ORDER_METRIC_DEFINITIONS,
      UNASSIGNED_SPEND_DEFINITION,
    ].map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("accepts a week with every figure and its evidence", () => {
    expect(spendWorkOrderMetrics.output.parse(answer)).toEqual(answer);
  });

  it("takes a day range of at most 92 days", () => {
    expect(() =>
      spendWorkOrderMetrics.input.parse({
        period: { from: "2026-07-01", to: "2026-09-30" },
      }),
    ).not.toThrow();
    expect(() =>
      spendWorkOrderMetrics.input.parse({
        period: { from: "2026-07-01", to: "2026-10-01" },
      }),
    ).toThrow();
  });

  it("refuses more weeks than a 92-day range touches", () => {
    expect(() =>
      spendWorkOrderMetrics.output.parse({
        ...answer,
        weeks: Array.from({ length: WORK_ORDER_METRICS_WEEKS_MAX + 1 }, () => week),
      }),
    ).toThrow();
  });

  it("names a touch's basis", () => {
    const bad = structuredClone(answer);
    (bad.weeks[0]!.operators[0]!.metrics.touchesPerDone as { basis: string }).basis =
      "corrections";
    expect(() => spendWorkOrderMetrics.output.parse(bad)).toThrow();
  });
});
