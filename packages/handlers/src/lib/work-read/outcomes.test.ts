// The outcome counts, from built projections (P1-05, #5163): accepted and
// merged, returned, and closed apart; lead time by nearest rank; review
// touches; cost coverage; the reopen cohort; and UTC weeks from Monday. The
// answer is parsed with get_work_outcomes' own output schema.
import { describe, expect, it } from "vitest";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { type WorkFact, reduceWorkItem } from "@oxagen/work/records";
import type { RunCost } from "./derive";
import { IN_REVIEW, O1, O2, READY, SHA1, f } from "./facts.test-support";
import { type OutcomeItem, computeOutcomes, nearestRank, weekStartOf, weeksBetween } from "./outcomes";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Friday 2026-10-02, 00:00 UTC: the fixtures' facts fall on the Thursday before. */
const NOW = new Date("2026-10-02T00:00:00.000Z");

function outcome(facts: WorkFact[], corrections = 0): OutcomeItem {
  return { facts, projection: reduceWorkItem(facts), corrections };
}

function shift(facts: readonly WorkFact[], ms: number): WorkFact[] {
  return facts.map((fact) => ({ ...fact, occurredAt: new Date(Date.parse(fact.occurredAt) + ms).toISOString() }) as WorkFact);
}

/** Done at 10:15 on 2026-10-01, a quarter hour after the source was read. */
const DONE_FAST = [...IN_REVIEW, f.accepted(O1, SHA1, 12), f.merged(O1, SHA1, 15)];

/** The same work on send O2, done at 12:00: two hours after the source was read. */
const DONE_SLOW = [
  ...READY,
  f.send(O2, 1, 1, 1, 4),
  f.runtime("claimed", O2, 5),
  f.runtime("run_linked", O2, 6),
  f.prLinked(O2, 7),
  f.head(O2, SHA1, 8),
  f.runtime("run_ended", O2, 9),
  f.required(O2, SHA1, ["test"], 10),
  f.check(O2, SHA1, "test", "success", 11),
  f.accepted(O2, SHA1, 60),
  f.merged(O2, SHA1, 120),
];

const usd = (micros: bigint | null): RunCost => ({ costMicros: micros, currency: "USD", basis: "metered", tier: "gateway" });

describe("nearestRank", () => {
  it("takes the value at ceil(p × n) of the sorted sample", () => {
    expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 3, 4], 0.9)).toBe(4);
    expect(nearestRank([5], 0.5)).toBe(5);
    expect(nearestRank([5], 0.9)).toBe(5);
  });

  it("answers null with no sample", () => {
    expect(nearestRank([], 0.5)).toBeNull();
  });
});

describe("UTC weeks from Monday", () => {
  it("starts each week on the Monday before, at midnight UTC", () => {
    expect(weekStartOf(new Date("2026-10-01T10:00:00.000Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(weekStartOf(new Date("2026-09-28T23:59:00.000Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(weekStartOf(new Date("2026-10-04T23:59:00.000Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("lists every week that overlaps the window", () => {
    expect(weeksBetween(new Date("2026-09-25T00:00:00.000Z"), NOW).map((week) => week.toISOString().slice(0, 10))).toEqual([
      "2026-09-21",
      "2026-09-28",
    ]);
  });
});

describe("computeOutcomes", () => {
  const items = [
    outcome(DONE_FAST, 2),
    outcome(DONE_SLOW),
    outcome([...IN_REVIEW, f.returned(O1, 12)]),
    outcome([f.collected(), f.triage("triaged"), f.closed(1, 5)]),
    // Done 35 and 33 days ago: in the reopen cohort for a 7-day window. The
    // first was reopened after it finished.
    outcome(shift([...DONE_FAST, f.reopened(2, 1, 16)], -35 * DAY_MS)),
    outcome(shift(DONE_FAST, -33 * DAY_MS)),
  ];
  const runs = new Map([
    ["tse_c1run", usd(1_000_000n)],
    ["tse_c2run", usd(null)],
  ]);
  const out = workOutcomesGet.output.parse({ ...computeOutcomes({ now: NOW, days: 7, items, runs }), truncated: false });

  it("counts accepted and merged, returned, and closed apart", () => {
    expect(out.days).toBe(7);
    expect(out.since).toBe("2026-09-25T00:00:00.000Z");
    expect(out.accepted_merged).toBe(2);
    expect(out.returned).toBe(1);
    expect(out.closed).toEqual({ cancelled: 0, declined: 1, duplicate: 0 });
  });

  it("measures lead time from the first source reading to the later of acceptance and merge", () => {
    expect(out.lead_time).toEqual({ median_hours: 0.25, p90_hours: 2, sample: 2 });
  });

  it("counts a person's decisions on the accepted items", () => {
    expect(out.touches).toEqual({
      per_item: 3,
      brief_approvals: 2,
      acceptances: 2,
      returns: 0,
      triage_overrides: 0,
      triage_corrections: 2,
    });
  });

  it("sums only the costs the rollup recorded", () => {
    expect(out.cost).toEqual({ runs: 2, known_runs: 1, total: { micros: "1000000", currency: "USD" } });
  });

  it("counts reopens only for items that finished 30 or more days ago", () => {
    expect(out.reopens).toEqual({ cohort: 2, reopened: 1, waiting: 2 });
  });

  it("splits the window into UTC weeks from Monday", () => {
    expect(out.weeks).toEqual([
      { week: "2026-09-21", accepted_merged: 0, returned: 0, median_lead_hours: null },
      { week: "2026-09-28", accepted_merged: 2, returned: 1, median_lead_hours: 0.25 },
    ]);
  });

  it("leaves out a lead time that would run backwards, and still counts the item", () => {
    const late = [f.collected(500), ...DONE_FAST.slice(1)];
    const result = computeOutcomes({ now: NOW, days: 7, items: [outcome(late)], runs: new Map() });
    expect(result.accepted_merged).toBe(1);
    expect(result.lead_time).toEqual({ median_hours: null, p90_hours: null, sample: 0 });
  });

  it("answers an empty window with no rates", () => {
    const result = workOutcomesGet.output.parse({ ...computeOutcomes({ now: NOW, days: 30, items: [], runs: new Map() }), truncated: false });
    expect(result.accepted_merged).toBe(0);
    expect(result.touches.per_item).toBeNull();
    expect(result.cost).toEqual({ runs: 0, known_runs: 0, total: null });
    expect(result.lead_time).toEqual({ median_hours: null, p90_hours: null, sample: 0 });
    expect(result.weeks.length).toBeGreaterThanOrEqual(5);
  });
});
