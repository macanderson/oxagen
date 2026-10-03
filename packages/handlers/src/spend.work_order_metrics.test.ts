import {
  assignedFrom,
  type MetricOrder,
  type MetricRun,
  type PricedSegment,
  segmentKey,
  type UnproductiveClaim,
} from "@oxagen/billing";
import {
  OPERATOR_METRIC_DEFINITIONS,
  spendWorkOrderMetrics,
  WORK_ORDER_METRIC_DEFINITIONS,
} from "@oxagen/oxagen/contracts/spend.work_order_metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorPseudonym } from "./lib/operator-pseudonyms";
import { createUnproductiveSpendHandler } from "./spend.unproductive";
import {
  createWorkOrderMetricsHandler,
  type WorkOrderMetricsDeps,
} from "./spend.work_order_metrics";
import { ctx } from "./spend.test-support";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const PERIOD = { from: "2026-09-28", to: "2026-10-04" };
const NOW = new Date("2026-10-20T00:00:00.000Z");
const ANA = "prn_0000000000000000000ana";
const BEN = "prn_0000000000000000000ben";
const SALT = "0192d4a8-7c1e-7a00-8000-0000000005a1";
const HOUR = 60 * 60 * 1000;

const id = (n: number) => `tse_${String(n).padStart(22, "0")}`;
const at = (iso: string) => new Date(iso);

function run(
  n: number,
  over: Partial<MetricRun> & { attachedAfterHours?: number | null } = {},
): MetricRun {
  const { attachedAfterHours, ...rest } = over;
  const base: MetricRun = {
    runId: id(n),
    operatorKey: ANA,
    agentKey: "acme.web.a",
    startedAt: at("2026-09-29T09:00:00.000Z"),
    lastFrameAt: at("2026-09-29T10:00:00.000Z"),
    costMicros: 100n,
    currency: "USD",
    tokens: 1_000,
    assignment: { kind: "direct", from: null },
    definitionOfDone: false,
    ...rest,
  };
  if (attachedAfterHours === undefined) return base;
  const from = assignedFrom({
    openedAt: base.startedAt,
    attachedAt:
      attachedAfterHours === null
        ? null
        : new Date(base.startedAt.getTime() + attachedAfterHours * HOUR),
  });
  return { ...base, assignment: { kind: "direct", from } };
}

function claim(
  n: number,
  operatorKey: string | null,
  micros: bigint,
  currency = "USD",
): UnproductiveClaim {
  return {
    detector: 1,
    runId: id(n),
    frameKey: "f1",
    operatorKey,
    costMicros: micros,
    currency,
  };
}

// Ana: one unassigned direct run (900) and one run of a send with a
// definition of done (400), which passed its check on Tuesday.
// Ben: a direct run attached 23 hours after it started (300, assigned) and
// one attached 25 hours after (200, unassigned).
const RUNS: MetricRun[] = [
  run(1, { costMicros: 900n, tokens: 9_000 }),
  run(2, {
    startedAt: at("2026-09-29T11:00:00.000Z"),
    lastFrameAt: at("2026-09-29T12:00:00.000Z"),
    costMicros: 400n,
    assignment: { kind: "send" },
    definitionOfDone: true,
  }),
  run(3, {
    operatorKey: BEN,
    agentKey: "acme.web.b",
    startedAt: at("2026-09-30T09:00:00.000Z"),
    lastFrameAt: at("2026-09-30T10:00:00.000Z"),
    costMicros: 300n,
    attachedAfterHours: 23,
  }),
  run(4, {
    operatorKey: BEN,
    agentKey: "acme.web.b",
    startedAt: at("2026-09-30T12:00:00.000Z"),
    lastFrameAt: at("2026-09-30T13:00:00.000Z"),
    costMicros: 200n,
    tokens: 2_000,
    attachedAfterHours: 25,
  }),
];

const ORDER: MetricOrder = {
  id: "00000000-0000-7000-8000-000000000001",
  publicId: "wo_ana1",
  operatorKey: ANA,
  agentKey: "acme.web.a",
  dispatchedAt: at("2026-09-29T10:30:00.000Z"),
  closedAt: at("2026-09-29T14:00:00.000Z"),
  definitionOfDone: true,
  checks: [{ checkedAt: at("2026-09-29T13:00:00.000Z"), result: "passed" }],
  rejections: [],
  runs: [
    {
      runId: id(2),
      startedAt: at("2026-09-29T11:00:00.000Z"),
      costMicros: 400n,
      currency: "USD",
    },
  ],
};

const CLAIMS = [claim(2, ANA, 100n), claim(3, BEN, 50n)];

function harness(
  over: {
    runs?: MetricRun[];
    claims?: UnproductiveClaim[];
    orders?: MetricOrder[];
    priced?: Map<string, PricedSegment | null>;
    policy?: { pseudonyms: boolean; salt: string | null };
  } = {},
) {
  const deps = {
    now: () => NOW,
    readClaims: vi.fn(async () => over.claims ?? CLAIMS),
    readRuns: vi.fn(async () => over.runs ?? RUNS),
    priceSegments: vi.fn(async () => over.priced ?? new Map()),
    readOrders: vi.fn(async () => over.orders ?? [ORDER]),
    readInterrupts: vi.fn(
      async () => new Map([[id(2), new Map([["2026-09-28", 3]])]]),
    ),
    readOperatorFacts: vi.fn(async () => new Map()),
    readPolicy: vi.fn(
      async () => over.policy ?? { pseudonyms: false, salt: null },
    ),
  } satisfies WorkOrderMetricsDeps;
  return { deps, handler: createWorkOrderMetricsHandler(deps) };
}

afterEach(() => {
  resetRoleGate();
});

function operator(
  out: Awaited<ReturnType<ReturnType<typeof harness>["handler"]>>,
  key: string,
) {
  const row = out.weeks[0]?.operators.find(
    (o) => o.operator.kind === "named" && o.operator.key === key,
  );
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

describe("get_work_order_metrics", () => {
  it("reports one whole week for a Monday-to-Sunday range and passes its contract", async () => {
    const out = await harness().handler({ period: PERIOD }, ctx());
    expect(out.weeks.map((w) => w.week)).toEqual([
      { from: "2026-09-28", to: "2026-10-04" },
    ]);
    expect(out.weeks[0]?.settled).toBe(true);
    expect(out.currency).toBe("USD");
    expect(() => spendWorkOrderMetrics.output.parse(out)).not.toThrow();
  });

  it("carries the definition of every metric it reports", async () => {
    const out = await harness().handler({ period: PERIOD }, ctx());
    expect(out.definitions.operator.map((d) => d.id)).toEqual(
      OPERATOR_METRIC_DEFINITIONS.map((d) => d.id),
    );
    expect(out.definitions.workOrder.map((d) => d.id)).toEqual(
      WORK_ORDER_METRIC_DEFINITIONS.map((d) => d.id),
    );
    expect(out.definitions.unassigned.id).toBe("unassigned_spend");
    const metrics = operator(out, ANA).metrics;
    // Each operator figure is keyed by its definition's id, in camel case.
    const camel = (s: string) =>
      s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    expect(Object.keys(metrics)).toEqual(
      OPERATOR_METRIC_DEFINITIONS.map((d) => camel(d.id)),
    );
    expect(Object.keys(out.weeks[0]?.workspace.workOrders ?? {})).toEqual([
      "done",
      ...WORK_ORDER_METRIC_DEFINITIONS.map((d) => camel(d.id)),
    ]);
  });

  it("keeps unassigned spend out of the headline total", async () => {
    const { handler } = harness();
    const out = await handler({ period: PERIOD }, ctx());
    const workspace = out.weeks[0]?.workspace;
    // Runs 1 and 4 are unassigned: 900 + 200.
    expect(workspace?.unassigned.spend?.micros).toBe("1100");
    expect(workspace?.unproductive.micros).toBe("150");

    // The headline for the same claims, from get_unproductive_spend, is the
    // claims alone, whatever the unassigned spend.
    const headline = await createUnproductiveSpendHandler({
      readClaims: async () => CLAIMS,
      readSpend: async () => ({
        rows: [{ operatorKey: null, currency: "USD", micros: 1_800n }],
        partial: new Set(),
      }),
      readKindSavings: async () => [],
      countFindingsOutside: async () => 0,
    })({ period: PERIOD }, ctx());
    expect(headline.unproductive.micros).toBe("150");
    expect(workspace?.unproductive).toEqual(headline.unproductive);
  });

  it("counts a direct work order attached at 23 hours as assigned from its run, and one at 25 hours as unassigned", async () => {
    const out = await harness().handler({ period: PERIOD }, ctx());
    const ben = operator(out, BEN);
    expect(ben.unassigned.runs.map((r) => r.runId)).toEqual([id(4)]);
    expect(ben.unassigned.spend?.micros).toBe("200");
    expect(ben.metrics.unassignedShare.value).toBe(200 / 500);
    expect(ben.metrics.unassignedShare.runs).toEqual([id(4)]);
  });

  it("reports the operator metrics with the runs and work orders behind them", async () => {
    const out = await harness().handler({ period: PERIOD }, ctx());
    const m = operator(out, ANA).metrics;
    expect(m.doneWorkOrders).toEqual({
      value: 1,
      workOrders: ["wo_ana1"],
      runs: [id(2)],
    });
    expect(m.costPerDone.value).toEqual({ micros: "400", currency: "USD" });
    expect(m.unproductiveShare).toEqual({ value: 100 / 1300, runs: [id(2)] });
    // Agent a ran two separate hours in a 168-hour week.
    expect(m.agentsInFlight.value).toBeCloseTo(2 / 168, 12);
    expect(m.agentsInFlight.agents).toEqual(["acme.web.a"]);
    expect(m.leverage.value).toBeCloseTo(84, 9);
    expect(m.touchesPerDone).toEqual({
      value: 3,
      touches: 3,
      basis: "interrupts",
      runs: [id(2)],
    });
    expect(m.unassignedShare.value).toBe(900 / 1300);
  });

  it("reports the work order metrics per operator, per agent, and for the workspace", async () => {
    const out = await harness().handler({ period: PERIOD }, ctx());
    const week = out.weeks[0];
    expect(week?.workspace.workOrders.done).toBe(1);
    expect(week?.workspace.workOrders.doneRate).toMatchObject({
      value: 1,
      numerator: 1,
      denominator: 1,
    });
    expect(week?.workspace.workOrders.timeToDone.valueMs).toBe(2.5 * HOUR);
    expect(operator(out, ANA).workOrders.firstPassRate.value).toBe(1);
    expect(operator(out, BEN).workOrders.done).toBe(0);
    expect(week?.agents.map((a) => a.agentKey)).toEqual([
      "acme.web.a",
      "acme.web.b",
    ]);
    expect(week?.agents[0]?.workOrders.costToDone.value?.micros).toBe("400");
  });

  it("prices the frames of a run that crosses the week's end", async () => {
    const crossing = run(5, {
      startedAt: at("2026-10-04T23:00:00.000Z"),
      lastFrameAt: at("2026-10-05T01:00:00.000Z"),
      costMicros: 1_000n,
    });
    const week = {
      start: at("2026-09-28T00:00:00.000Z"),
      end: at("2026-10-05T00:00:00.000Z"),
    };
    const { deps, handler } = harness({
      runs: [crossing],
      claims: [],
      orders: [],
      priced: new Map([
        [segmentKey(crossing.runId, week), { micros: 400n, tokens: 4_000 }],
      ]),
    });
    const out = await handler({ period: PERIOD }, ctx());
    expect(deps.priceSegments).toHaveBeenCalledTimes(1);
    expect(out.weeks[0]?.workspace.spend?.micros).toBe("400");
    expect(out.weeks[0]?.workspace.unassigned.spend?.micros).toBe("400");
    expect(out.weeks[0]?.workspace.unassigned.tokens).toBe(4_000);
  });

  it("hides what could match a pseudonym to a name and keeps the counts", async () => {
    const out = await harness({
      policy: { pseudonyms: true, salt: SALT },
    }).handler({ period: PERIOD }, ctx());
    expect(out.pseudonyms).toBe(true);
    const ana = out.weeks[0]?.operators.find(
      (o) =>
        o.operator.kind === "pseudonym" &&
        o.operator.pseudonym === operatorPseudonym(SALT, ANA),
    );
    expect(ana?.metrics.doneWorkOrders).toEqual({
      value: 1,
      workOrders: [],
      runs: [],
    });
    expect(ana?.metrics.unproductiveShare).toEqual({ value: null, runs: [] });
    expect(ana?.metrics.unassignedShare).toEqual({ value: null, runs: [] });
    expect(ana?.metrics.agentsInFlight.agents).toEqual([]);
    expect(ana?.unassigned).toEqual({
      spend: null,
      tokens: null,
      share: null,
      runs: [],
    });
    expect(JSON.stringify(out.weeks[0]?.operators)).not.toContain(ANA);
    expect(() => spendWorkOrderMetrics.output.parse(out)).not.toThrow();
  });

  it("refuses a period whose spend holds two currencies", async () => {
    const refusal = harness({
      runs: [...RUNS, run(9, { currency: "EUR" })],
    }).handler({ period: PERIOD }, ctx());
    await expect(refusal).rejects.toMatchObject({
      code: "conflict",
      reason: "work_order_metrics_mixed_currency",
    });
  });

  it("is for an org Owner or Admin", async () => {
    roleGate.roles = { org: "Member" };
    await expect(
      harness().handler({ period: PERIOD }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden" });
    roleGate.roles = { org: "Admin" };
    await expect(
      harness().handler({ period: PERIOD }, ctx()),
    ).resolves.toBeDefined();
  });
});
