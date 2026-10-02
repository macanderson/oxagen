// The outcome counts, from built projections (P1-05, #5163): accepted and
// merged, returned, and closed apart; lead time by nearest rank; review
// touches; cost coverage; the reopen cohort; and UTC weeks from Monday. The
// pilot measures (P1-06, #5241): each send in one delivery bucket, claim time,
// and each week's intake and full flow. The answer is parsed with
// get_work_outcomes' own output schema.
import { describe, expect, it } from "vitest";
import { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { type WorkFact, reduceWorkItem } from "@oxagen/work/records";
import type { RunCost } from "./derive";
import { IN_REVIEW, O1, O2, READY, SHA1, at, f } from "./facts.test-support";
import {
  type OutcomeItem,
  type OutcomesInput,
  type SendOutcome,
  computeOutcomes,
  nearestRank,
  weekStartOf,
  weeksBetween,
} from "./outcomes";

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

/** A 7-day window with nothing in it. */
const EMPTY: OutcomesInput = { now: NOW, days: 7, items: [], runs: new Map(), sends: [], intake: [] };

/** A send at `minute`, changed by `over`. */
function send(minute: number, over: Partial<SendOutcome> = {}): SendOutcome {
  return { requestedAt: at(minute), claimedAt: null, rejected: false, withdrawn: false, ...over };
}

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
  // The database named only the week the fixtures fall in.
  const intake = [{ week: "2026-09-28", entered: 4, sent: 3 }];
  const out = workOutcomesGet.output.parse({ ...computeOutcomes({ now: NOW, days: 7, items, runs, sends: [], intake }), truncated: false });

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

  it("splits the window into UTC weeks from Monday, with each week's intake and full flow", () => {
    expect(out.weeks).toEqual([
      { week: "2026-09-21", accepted_merged: 0, returned: 0, median_lead_hours: null, entered: 0, sent: 0, full_flow: false },
      { week: "2026-09-28", accepted_merged: 2, returned: 1, median_lead_hours: 0.25, entered: 4, sent: 3, full_flow: true },
    ]);
  });

  it("leaves out a lead time that would run backwards, and still counts the item", () => {
    const late = [f.collected(500), ...DONE_FAST.slice(1)];
    const result = computeOutcomes({ ...EMPTY, items: [outcome(late)] });
    expect(result.accepted_merged).toBe(1);
    expect(result.lead_time).toEqual({ median_hours: null, p90_hours: null, sample: 0 });
  });

  it("answers an empty window with no rates", () => {
    const result = workOutcomesGet.output.parse({ ...computeOutcomes({ ...EMPTY, days: 30 }), truncated: false });
    expect(result.accepted_merged).toBe(0);
    expect(result.touches.per_item).toBeNull();
    expect(result.cost).toEqual({ runs: 0, known_runs: 0, total: null });
    expect(result.lead_time).toEqual({ median_hours: null, p90_hours: null, sample: 0 });
    expect(result.delivery).toEqual({
      sends: 0,
      claimed: 0,
      rejected: 0,
      withdrawn: 0,
      waiting: 0,
      claim_minutes: { median: null, p90: null, sample: 0 },
    });
    expect(result.weeks.length).toBeGreaterThanOrEqual(5);
    expect(result.weeks.every((week) => week.entered === 0 && week.sent === 0 && !week.full_flow)).toBe(true);
  });
});

describe("the pilot measures", () => {
  it("puts each send in one bucket, and the buckets add up to the sends", () => {
    const sends = [
      send(0, { claimedAt: at(2) }),
      send(0, { rejected: true }),
      send(0, { withdrawn: true }),
      send(0),
      // Claimed, then withdrawn after a stop no run confirmed: the runtime received it.
      send(0, { claimedAt: at(10), withdrawn: true }),
      // Claimed, then rejected: a rejection outranks the claim.
      send(0, { claimedAt: at(1), rejected: true }),
    ];
    const { delivery } = workOutcomesGet.output.parse({ ...computeOutcomes({ ...EMPTY, sends }), truncated: false });
    expect(delivery).toEqual({
      sends: 6,
      claimed: 2,
      rejected: 2,
      withdrawn: 1,
      waiting: 1,
      claim_minutes: { median: 2, p90: 10, sample: 2 },
    });
    expect(delivery.claimed + delivery.rejected + delivery.withdrawn + delivery.waiting).toBe(delivery.sends);
  });

  it("measures claim time over the claimed sends, and leaves out one that would run backwards", () => {
    const claimed = [1, 3, 5, 7, 9].map((gap) => send(10, { claimedAt: at(10 + gap) }));
    const backwards = send(10, { claimedAt: at(5) });
    const { delivery } = computeOutcomes({ ...EMPTY, sends: [...claimed, backwards] });
    expect(delivery.claimed).toBe(6);
    expect(delivery.claim_minutes).toEqual({ median: 5, p90: 9, sample: 5 });
  });

  it("reads each week's entered and sent counts from the database's intake, and 0 for a week it did not name", () => {
    const result = computeOutcomes({ ...EMPTY, intake: [{ week: "2026-09-21", entered: 2, sent: 1 }] });
    expect(result.weeks.map(({ week, entered, sent }) => ({ week, entered, sent }))).toEqual([
      { week: "2026-09-21", entered: 2, sent: 1 },
      { week: "2026-09-28", entered: 0, sent: 0 },
    ]);
  });

  it("marks the full flow only in a week where an item was accepted and merged", () => {
    const returned = outcome([...IN_REVIEW, f.returned(O1, 12)]);
    const closed = outcome([f.collected(), f.triage("triaged"), f.closed(1, 5)]);
    const intake = [{ week: "2026-09-28", entered: 2, sent: 1 }];
    const without = computeOutcomes({ ...EMPTY, items: [returned, closed], intake });
    expect(without.weeks.map((week) => week.full_flow)).toEqual([false, false]);
    const done = computeOutcomes({ ...EMPTY, items: [returned, closed, outcome(DONE_FAST)], intake });
    expect(done.weeks.map((week) => week.full_flow)).toEqual([false, true]);
  });
});
