// outcomes.ts: what the workspace's Phase 1 work finished in a window of
// days, counted from the work records (P1-05, #5163; agent-work-phase-1.html,
// Screens: Outcome view, and Release gates: the measures).
//
// Pure. read.ts loads the items whose records can count and their run costs,
// and computeOutcomes counts them. Every figure comes from a fact, and none is
// estimated:
//
//   - An item counts as accepted and merged when the later of its acceptance
//     and its merge (its done time) falls in the window. An item done twice in
//     the window, around a reopen, counts once, at its latest done time.
//   - Returned counts the sends a person returned in the window. Closed counts
//     the closes in the window, by resolution. The three counts never add up
//     into one rate.
//   - Lead time runs from the item's first source reading to its done time. A
//     lead time that would run backwards, because the provider's clock and
//     Oxagen's disagree, is left out of the sample rather than read as zero.
//   - Review touches are a person's decisions on the accepted items, over
//     their whole life: brief approvals, acceptances, returns, triage
//     overrides, and triage corrections.
//   - Cost sums the runs linked to the accepted items' sends whose cost the
//     rollup recorded. A run with no recorded cost adds nothing and stays
//     unknown.
//   - The reopen cohort is the items whose done time falls 30 to 30 + days
//     days ago. One reopened when a reopen fact follows that done time. Items
//     done in the last 30 days wait to count.
//   - Weeks are UTC weeks from Monday that overlap the window.
//
// Median and 90th percentile use the nearest rank: the value at position
// ceil(p * n) of the sorted sample. Both are null with no sample.
import type { WorkOutcomesGetOutput } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { type WorkFact, type WorkItemProjection, sortFacts } from "@oxagen/work/records";
import { type RunCost, costOf, doneAtOf } from "./derive";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How many days an item waits after it finishes before its reopens count. */
export const REOPEN_WAIT_DAYS = 30;

/** One item whose records can count. */
export interface OutcomeItem {
  facts: readonly WorkFact[];
  projection: WorkItemProjection;
  /** How many triage corrections a person made on the item. */
  corrections: number;
}

export interface OutcomesInput {
  now: Date;
  days: number;
  items: readonly OutcomeItem[];
  runs: ReadonlyMap<string, RunCost>;
}

/** The value at nearest rank `p` of an ascending sample, or null with no sample. Pure. */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/** The Monday 00:00 UTC that starts the week holding `at`. Pure. */
export function weekStartOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

/** Each UTC Monday whose week overlaps [start, end], oldest first. Pure. */
export function weeksBetween(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  for (let week = weekStartOf(start); week.getTime() <= end.getTime(); week = new Date(week.getTime() + 7 * DAY_MS)) {
    out.push(week);
  }
  return out;
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function within(time: number, start: number, end: number): boolean {
  return time >= start && time <= end;
}

/** Every done time of the item's sends, in milliseconds. */
function doneTimes(projection: WorkItemProjection): number[] {
  const out: number[] = [];
  for (const order of projection.orders) {
    const at = doneAtOf(order);
    if (at !== null) out.push(Date.parse(at));
  }
  return out;
}

/** The latest of `times` in [start, end], or null. */
function latestWithin(times: readonly number[], start: number, end: number): number | null {
  let latest: number | null = null;
  for (const time of times) {
    if (within(time, start, end) && (latest === null || time > latest)) latest = time;
  }
  return latest;
}

/** When the item's source was first read: its first collected or entered fact. */
function firstSourceAt(facts: readonly WorkFact[]): number | null {
  const first = sortFacts(facts).find((fact) => fact.kind === "collected" || fact.kind === "entered");
  return first === undefined ? null : Date.parse(first.occurredAt);
}

function countKind(facts: readonly WorkFact[], kind: WorkFact["kind"]): number {
  return facts.filter((fact) => fact.kind === kind).length;
}

/** One accepted item in the window, with its done time and lead time. */
interface Accepted {
  item: OutcomeItem;
  doneAt: number;
  /** Hours from the first source reading to the done time, or null when it cannot be measured. */
  leadHours: number | null;
}

/** Count what the work finished in the window. Pure. */
export function computeOutcomes(input: OutcomesInput): WorkOutcomesGetOutput {
  const end = input.now.getTime();
  const start = end - input.days * DAY_MS;

  const accepted: Accepted[] = [];
  for (const item of input.items) {
    const doneAt = latestWithin(doneTimes(item.projection), start, end);
    if (doneAt === null) continue;
    const first = firstSourceAt(item.facts);
    const lead = first === null ? null : (doneAt - first) / HOUR_MS;
    accepted.push({ item, doneAt, leadHours: lead === null || lead < 0 ? null : lead });
  }

  const returnedAt: number[] = [];
  const closed = { cancelled: 0, declined: 0, duplicate: 0 };
  for (const item of input.items) {
    for (const fact of item.facts) {
      const at = Date.parse(fact.occurredAt);
      if (!within(at, start, end)) continue;
      if (fact.kind === "returned") returnedAt.push(at);
      if (fact.kind === "closed") closed[fact.data.resolution] += 1;
    }
  }

  const leads = accepted.flatMap((entry) => (entry.leadHours === null ? [] : [entry.leadHours])).sort((a, b) => a - b);

  const touches = { brief_approvals: 0, acceptances: 0, returns: 0, triage_overrides: 0, triage_corrections: 0 };
  for (const { item } of accepted) {
    touches.brief_approvals += countKind(item.facts, "brief_approved");
    touches.acceptances += countKind(item.facts, "accepted");
    touches.returns += countKind(item.facts, "returned");
    touches.triage_overrides += countKind(item.facts, "triage_overridden");
    touches.triage_corrections += item.corrections;
  }
  const touchTotal =
    touches.brief_approvals + touches.acceptances + touches.returns + touches.triage_overrides + touches.triage_corrections;

  const runIds = accepted.flatMap(({ item }) => item.projection.orders.flatMap((order) => order.runIds));

  const waitFrom = end - REOPEN_WAIT_DAYS * DAY_MS;
  const cohortFrom = waitFrom - input.days * DAY_MS;
  let cohort = 0;
  let reopened = 0;
  let waiting = 0;
  for (const item of input.items) {
    const times = doneTimes(item.projection);
    if (times.some((time) => time > waitFrom && time <= end)) waiting += 1;
    const doneAt = latestWithin(times, cohortFrom, waitFrom);
    if (doneAt === null) continue;
    cohort += 1;
    if (item.facts.some((fact) => fact.kind === "reopened" && Date.parse(fact.occurredAt) > doneAt)) reopened += 1;
  }

  const weeks = weeksBetween(new Date(start), input.now).map((week) => {
    const from = Math.max(week.getTime(), start);
    const to = Math.min(week.getTime() + 7 * DAY_MS - 1, end);
    const inWeek = accepted.filter((entry) => within(entry.doneAt, from, to));
    const weekLeads = inWeek.flatMap((entry) => (entry.leadHours === null ? [] : [entry.leadHours])).sort((a, b) => a - b);
    return {
      week: isoDay(week),
      accepted_merged: inWeek.length,
      returned: returnedAt.filter((at) => within(at, from, to)).length,
      median_lead_hours: nearestRank(weekLeads, 0.5),
    };
  });

  return {
    days: input.days,
    since: new Date(start).toISOString(),
    accepted_merged: accepted.length,
    returned: returnedAt.length,
    closed,
    lead_time: { median_hours: nearestRank(leads, 0.5), p90_hours: nearestRank(leads, 0.9), sample: leads.length },
    touches: { per_item: accepted.length === 0 ? null : touchTotal / accepted.length, ...touches },
    cost: costOf(runIds, input.runs),
    reopens: { cohort, reopened, waiting },
    weeks,
  };
}
