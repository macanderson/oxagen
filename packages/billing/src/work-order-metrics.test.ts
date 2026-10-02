import { describe, expect, it } from "vitest";
import {
  agentsInFlight,
  assignedFrom,
  DIRECT_ORDER_GRACE_HOURS,
  doneAt,
  doneWorkOrders,
  type MetricOrder,
  type MetricRun,
  type PricedSegment,
  runSegmentsToPrice,
  segmentKey,
  shareOf,
  splitRunSpend,
  sumRunSpend,
  tokenTotal,
  weekSettled,
  weeksOverlapping,
  workOrderMetrics,
} from "./work-order-metrics";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const after = (base: Date, hours: number) =>
  new Date(base.getTime() + hours * HOUR);

// Monday 28 September 2026 to Monday 5 October 2026.
const WEEK = { start: at("2026-09-28T00:00:00.000Z"), end: at("2026-10-05T00:00:00.000Z") };
const NOW = at("2026-10-20T00:00:00.000Z");

function run(over: Partial<MetricRun> = {}): MetricRun {
  return {
    runId: "tse_run1",
    operatorKey: "prn_ana",
    agentKey: "acme.web.fixer",
    startedAt: at("2026-09-29T09:00:00.000Z"),
    lastFrameAt: at("2026-09-29T10:00:00.000Z"),
    costMicros: 1_000_000n,
    currency: "USD",
    tokens: 5_000,
    assignment: { kind: "direct", from: null },
    definitionOfDone: false,
    ...over,
  };
}

function directRun(attachedAfterHours: number | null, over: Partial<MetricRun> = {}): MetricRun {
  const base = run(over);
  const from = assignedFrom({
    openedAt: base.startedAt,
    attachedAt: attachedAfterHours === null ? null : after(base.startedAt, attachedAfterHours),
  });
  return { ...base, assignment: { kind: "direct", from } };
}

function only<T>(rows: T[][]): T {
  const row = rows[0]?.[0];
  if (row === undefined) throw new Error("expected one row");
  return row;
}

describe("assignedFrom (decision 4)", () => {
  const openedAt = at("2026-09-29T09:00:00.000Z");

  it("counts a direct work order attached 23 hours after its first run as assigned from that run", () => {
    expect(assignedFrom({ openedAt, attachedAt: after(openedAt, 23) })).toEqual(openedAt);
  });

  it("counts a direct work order attached at 25 hours as assigned only from the attachment on", () => {
    const attachedAt = after(openedAt, 25);
    expect(assignedFrom({ openedAt, attachedAt })).toEqual(attachedAt);
  });

  it("counts an attachment at exactly 24 hours as inside the window", () => {
    expect(DIRECT_ORDER_GRACE_HOURS).toBe(24);
    expect(assignedFrom({ openedAt, attachedAt: after(openedAt, 24) })).toEqual(openedAt);
  });

  it("leaves an unattached direct work order unassigned", () => {
    expect(assignedFrom({ openedAt, attachedAt: null })).toBeNull();
  });
});

describe("unassigned spend from the grace rule", () => {
  it("puts none of a run's spend on the unassigned line when its direct work order was attached at 23 hours", () => {
    const r = directRun(23);
    expect(runSegmentsToPrice(r, [WEEK])).toEqual([]);
    const row = only(splitRunSpend([r], [WEEK], new Map()));
    expect(row.spend).toBe(1_000_000n);
    expect(row.unassigned).toBe(0n);
    expect(row.unassignedTokens).toBe(0);
  });

  it("puts all of a finished run's spend on the unassigned line when its direct work order was attached at 25 hours", () => {
    const r = directRun(25);
    expect(runSegmentsToPrice(r, [WEEK])).toEqual([]);
    const row = only(splitRunSpend([r], [WEEK], new Map()));
    expect(row.spend).toBe(1_000_000n);
    expect(row.unassigned).toBe(1_000_000n);
    expect(row.unassignedTokens).toBe(5_000);
  });

  it("counts a run still open at a 25-hour attachment as unassigned only up to the attachment", () => {
    // The run starts Tuesday 09:00 and its last frame is Wednesday 12:00.
    // The attachment at 25 hours lands Wednesday 10:00.
    const r = directRun(25, { lastFrameAt: at("2026-09-30T12:00:00.000Z") });
    const attachedAt = at("2026-09-30T10:00:00.000Z");
    const segments = runSegmentsToPrice(r, [WEEK]);
    expect(segments).toEqual([{ start: WEEK.start, end: attachedAt }]);
    const priced = new Map<string, PricedSegment | null>([
      [segmentKey(r.runId, { start: WEEK.start, end: attachedAt }), { micros: 600_000n, tokens: 3_000 }],
    ]);
    const row = only(splitRunSpend([r], [WEEK], priced));
    expect(row.spend).toBe(1_000_000n);
    expect(row.unassigned).toBe(600_000n);
    expect(row.unassignedTokens).toBe(3_000);
  });

  it("counts the same open run as assigned from its start when the attachment came at 23 hours", () => {
    const r = directRun(23, { lastFrameAt: at("2026-09-30T12:00:00.000Z") });
    expect(runSegmentsToPrice(r, [WEEK])).toEqual([]);
    expect(only(splitRunSpend([r], [WEEK], new Map())).unassigned).toBe(0n);
  });

  it("leaves the unassigned part unknown when its frames were not priced", () => {
    const r = directRun(25, { lastFrameAt: at("2026-09-30T12:00:00.000Z") });
    const row = only(splitRunSpend([r], [WEEK], new Map()));
    expect(row.spend).toBe(1_000_000n);
    expect(row.unassigned).toBeNull();
    expect(sumRunSpend([row], "USD").unassigned).toBeNull();
  });

  it("puts a send's spend and an unrecorded run's spend on no unassigned line", () => {
    const send = run({ runId: "tse_send", assignment: { kind: "send" }, definitionOfDone: true });
    const old = run({ runId: "tse_old", assignment: { kind: "not_recorded" } });
    const rows = splitRunSpend([send, old], [WEEK], new Map())[0] ?? [];
    const sum = sumRunSpend(rows, "USD");
    expect(sum.spend).toBe(2_000_000n);
    expect(sum.unassigned).toBe(0n);
    expect(sum.definitionOfDone).toBe(1_000_000n);
    expect(sum.notRecorded).toBe(1_000_000n);
  });

  it("prices a run that crosses a week's edge by the frames inside each week", () => {
    const r = run({
      startedAt: at("2026-10-04T23:00:00.000Z"),
      lastFrameAt: at("2026-10-05T01:00:00.000Z"),
    });
    const next = { start: WEEK.end, end: at("2026-10-12T00:00:00.000Z") };
    expect(runSegmentsToPrice(r, [WEEK, next])).toEqual([WEEK, next]);
    const priced = new Map<string, PricedSegment | null>([
      [segmentKey(r.runId, WEEK), { micros: 400_000n, tokens: 2_000 }],
      [segmentKey(r.runId, next), { micros: 600_000n, tokens: 3_000 }],
    ]);
    const [first, second] = splitRunSpend([r], [WEEK, next], priced);
    expect(first?.[0]?.spend).toBe(400_000n);
    expect(first?.[0]?.unassigned).toBe(400_000n);
    expect(second?.[0]?.spend).toBe(600_000n);
    expect(second?.[0]?.unassigned).toBe(600_000n);
  });

  it("sums no figure across two currencies", () => {
    const rows = splitRunSpend(
      [run({ runId: "tse_a" }), run({ runId: "tse_b", currency: "EUR" })],
      [WEEK],
      new Map(),
    )[0] ?? [];
    const sum = sumRunSpend(rows, "USD");
    expect(sum.spend).toBeNull();
    expect(sum.unassigned).toBeNull();
  });

  it("cites the unassigned runs largest first", () => {
    const rows = splitRunSpend(
      [run({ runId: "tse_small", costMicros: 10n }), run({ runId: "tse_big", costMicros: 90n })],
      [WEEK],
      new Map(),
    )[0] ?? [];
    expect(sumRunSpend(rows, "USD").unassignedRuns.map((r) => r.runId)).toEqual(["tse_big", "tse_small"]);
  });
});

describe("weeks", () => {
  it("covers each whole Monday-to-Sunday week the range touches", () => {
    const weeks = weeksOverlapping("2026-09-01", "2026-09-30");
    expect(weeks.map((w) => [w.from, w.to])).toEqual([
      ["2026-08-31", "2026-09-06"],
      ["2026-09-07", "2026-09-13"],
      ["2026-09-14", "2026-09-20"],
      ["2026-09-21", "2026-09-27"],
      ["2026-09-28", "2026-10-04"],
    ]);
    expect(weeks[0]?.start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(weeks[4]?.end.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("settles a week a day after it ends", () => {
    expect(weekSettled(WEEK, at("2026-10-05T23:59:59.000Z"))).toBe(false);
    expect(weekSettled(WEEK, at("2026-10-06T00:00:00.000Z"))).toBe(true);
  });
});

describe("agentsInFlight", () => {
  it("averages distinct agents with a run open, counting two runs of one agent once", () => {
    const day = (d: number, h: number) => at(`2026-10-0${d}T${String(h).padStart(2, "0")}:00:00.000Z`);
    const result = agentsInFlight(
      [
        // Agent a: two overlapping runs cover Thursday 00:00 to 12:00.
        { operatorKey: "prn_ana", agentKey: "a", startedAt: day(1, 0), lastFrameAt: day(1, 10) },
        { operatorKey: "prn_ana", agentKey: "a", startedAt: day(1, 6), lastFrameAt: day(1, 12) },
        // Agent b: Friday 00:00 to 12:00.
        { operatorKey: "prn_ana", agentKey: "b", startedAt: day(2, 0), lastFrameAt: day(2, 12) },
        { operatorKey: "prn_ana", agentKey: null, startedAt: day(2, 0), lastFrameAt: day(2, 12) },
      ],
      WEEK,
      NOW,
    );
    // 24 agent-hours over a 168-hour week.
    expect(result.average).toBeCloseTo(24 / 168, 10);
    expect(result.agents).toEqual(["a", "b"]);
  });

  it("averages the current week over the part that has passed", () => {
    const result = agentsInFlight(
      [{ operatorKey: null, agentKey: "a", startedAt: WEEK.start, lastFrameAt: WEEK.end }],
      WEEK,
      at("2026-09-29T00:00:00.000Z"),
    );
    expect(result.average).toBe(1);
  });
});

describe("work order metrics (decision 5)", () => {
  const sentAt = at("2026-09-28T08:00:00.000Z");
  function order(over: Partial<MetricOrder> = {}): MetricOrder {
    return {
      id: "00000000-0000-7000-8000-000000000001",
      publicId: "wo_one",
      operatorKey: "prn_ana",
      agentKey: "acme.web.fixer",
      dispatchedAt: sentAt,
      closedAt: null,
      definitionOfDone: true,
      checks: [],
      rejections: [],
      runs: [],
      ...over,
    };
  }
  const r = (id: string, startedAt: string, micros: bigint) => ({
    runId: id,
    startedAt: at(startedAt),
    costMicros: micros,
    currency: "USD",
  });

  // Done on the first try, two runs, closed after the pass.
  const firstTry = order({
    publicId: "wo_first",
    checks: [{ checkedAt: at("2026-09-29T10:00:00.000Z"), result: "passed" }],
    closedAt: at("2026-09-29T12:00:00.000Z"),
    runs: [r("tse_f1", "2026-09-28T09:00:00.000Z", 300n), r("tse_f2", "2026-09-29T09:00:00.000Z", 100n)],
  });
  // Failed once, then passed: the run after the failure is rework. A run
  // after the pass is not in the cost to done. A person returned it after
  // the pass, so it adds to the reopen rate.
  const reworked = order({
    publicId: "wo_rework",
    dispatchedAt: at("2026-09-28T00:00:00.000Z"),
    checks: [
      { checkedAt: at("2026-09-29T00:00:00.000Z"), result: "pending" },
      { checkedAt: at("2026-09-30T00:00:00.000Z"), result: "failed" },
      { checkedAt: at("2026-10-01T00:00:00.000Z"), result: "passed" },
    ],
    rejections: [at("2026-10-03T00:00:00.000Z")],
    runs: [
      r("tse_r1", "2026-09-28T01:00:00.000Z", 200n),
      r("tse_r2", "2026-09-30T06:00:00.000Z", 400n),
      r("tse_r3", "2026-10-02T06:00:00.000Z", 999n),
    ],
  });
  // Closed with no passing check: abandoned.
  const abandoned = order({
    publicId: "wo_abandoned",
    checks: [{ checkedAt: at("2026-09-30T00:00:00.000Z"), result: "failed" }],
    closedAt: at("2026-10-01T00:00:00.000Z"),
    runs: [r("tse_a1", "2026-09-29T00:00:00.000Z", 700n)],
  });
  // No definition of done: never done, out of every metric.
  const noRecord = order({
    publicId: "wo_none",
    definitionOfDone: false,
    checks: [{ checkedAt: at("2026-09-29T00:00:00.000Z"), result: "passed" }],
    closedAt: at("2026-09-30T00:00:00.000Z"),
    runs: [r("tse_n1", "2026-09-29T00:00:00.000Z", 5_000n)],
  });
  const all = [firstTry, reworked, abandoned, noRecord];

  it("counts a work order done at its first passing check run", () => {
    expect(doneAt(reworked)).toEqual(at("2026-10-01T00:00:00.000Z"));
    expect(doneAt(abandoned)).toBeNull();
    expect(doneAt(noRecord)).toBeNull();
    expect(doneWorkOrders(all, WEEK).map((d) => d.order.publicId)).toEqual(["wo_first", "wo_rework"]);
  });

  it("reports the seven work order metrics", () => {
    const m = workOrderMetrics(all, WEEK, "USD", NOW);
    expect(m.done).toBe(2);
    // Two closed in the week with a definition of done; one had passed.
    expect(m.doneRate).toMatchObject({ value: 0.5, numerator: 1, denominator: 2, workOrders: ["wo_first"] });
    expect(m.firstPassRate).toMatchObject({ value: 0.5, numerator: 1, denominator: 2, workOrders: ["wo_first"] });
    // (300 + 100) + (200 + 400) over 2 done work orders.
    expect(m.costToDone.micros).toBe(500n);
    expect(m.costToDone.runs).toEqual(["tse_f1", "tse_f2", "tse_r1", "tse_r2"]);
    // 26 hours and 72 hours.
    expect(m.timeToDone.ms).toBe(49 * HOUR);
    expect(m.reworkSpend).toMatchObject({ micros: 400n, workOrders: ["wo_rework"], runs: ["tse_r2"] });
    expect(m.abandonedSpend).toMatchObject({ micros: 700n, workOrders: ["wo_abandoned"], runs: ["tse_a1"] });
    // A person returned wo_rework two days after its passing check.
    expect(m.reopenRate).toMatchObject({ value: 0.5, numerator: 1, denominator: 2, pending: 0, workOrders: ["wo_rework"] });
  });

  it("does not count a rejection more than 14 days after the passing check", () => {
    const late = { ...reworked, rejections: [at("2026-10-16T00:00:00.000Z")] };
    expect(workOrderMetrics([late], WEEK, "USD", NOW).reopenRate).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it("counts a done work order whose reopen window is still open as pending", () => {
    const m = workOrderMetrics([firstTry], WEEK, "USD", at("2026-10-02T00:00:00.000Z"));
    expect(m.reopenRate).toMatchObject({ numerator: 0, denominator: 1, pending: 1 });
  });

  it("reports no rate and no mean when nothing was done or closed", () => {
    const m = workOrderMetrics([], WEEK, "USD", NOW);
    expect(m.done).toBe(0);
    expect(m.doneRate.value).toBeNull();
    expect(m.firstPassRate.value).toBeNull();
    expect(m.costToDone.micros).toBeNull();
    expect(m.timeToDone.ms).toBeNull();
    expect(m.reworkSpend.micros).toBe(0n);
    expect(m.abandonedSpend.micros).toBe(0n);
  });

  it("reports no spend figure when a run is priced in another currency", () => {
    const eur = { ...firstTry, runs: [{ ...r("tse_e", "2026-09-28T09:00:00.000Z", 1n), currency: "EUR" }] };
    expect(workOrderMetrics([eur], WEEK, "USD", NOW).costToDone.micros).toBeNull();
  });
});

describe("helpers", () => {
  it("adds every token class but server tool requests", () => {
    expect(
      tokenTotal({
        input_uncached: 1,
        cache_read: 2,
        cache_write_5m: 3,
        cache_write_1h: 4,
        output: 5,
        reasoning: 6,
        server_tool_request: 100,
      }),
    ).toBe(21);
    expect(tokenTotal(null)).toBe(0);
  });

  it("caps a share at 1 and gives none over nothing", () => {
    expect(shareOf(3n, 2n)).toBe(1);
    expect(shareOf(1n, 4n)).toBe(0.25);
    expect(shareOf(1n, 0n)).toBeNull();
    expect(shareOf(null, 4n)).toBeNull();
  });
});
