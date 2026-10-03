// outcomes.ts: what the workspace's Phase 1 work finished in a window of
// days, counted from the work records (P1-05, #5163; agent-work-phase-1.html,
// Screens: Outcome view, and Release gates: the measures).
//
// Pure. read.ts loads the items whose records can count, their run costs, the
// sends in the window, and the weekly intake counts, and computeOutcomes
// counts them. Every figure comes from a fact, and none is
// estimated:
//
//   - An item counts as accepted and merged when the later of its acceptance
//     and its merge (its done time) falls in the window. The count is of
//     distinct items, never sends: an item done twice in the window, around a
//     reopen, counts once, at its latest done time, and so in one week only.
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
//   - Reverts count over the reopen cohort below, and share its waiting
//     count. A cohort item counts as reverted when the send whose done time
//     placed it in the cohort carries a reverted fact: GitHub merged a pull
//     request whose body names that send's pull request as
//     `Reverts <owner>/<repo>#<n>`. A revert made by hand without that line is
//     not recorded, so it is not counted. A revert of the revert does not
//     clear it. The fact never moves the item out of done.
//   - The reopen cohort is the items whose done time falls 30 to 30 + days
//     days ago. One reopened when a reopen fact follows that done time. Items
//     done in the last 30 days wait to count.
//   - Weeks are UTC weeks from Monday that overlap the window. A week is
//     complete when the window covers all of it. The oldest week the window
//     cuts and the week still running are not, so a reader who wants whole
//     weeks reads only the complete rows.
//   - Delivery puts each send read.ts loaded for the window in one bucket, in
//     this order: rejected when it has a send_rejected fact, claimed when a
//     runtime claimed it, withdrawn when a person withdrew it, and waiting
//     otherwise. The four buckets add up to the sends.
//   - A send claimed and then withdrawn, after a stop no run confirmed,
//     counts as claimed: the runtime received it. reduceWorkItem
//     (@oxagen/work/records) ranks the withdrawal first, because it asks what
//     state the send is in now. Delivery asks whether the runtime received it.
//   - Claim time runs from the send to its first claim, over the claimed
//     sends. A claim time that would run backwards is left out of the sample,
//     as lead time is.
//   - A week's entered and sent counts come from read.ts, which counts them
//     in the database with no cap. A week the database did not name counts 0.
//   - A week used the full flow when at least one item was accepted and
//     merged in it.
//
// Median and 90th percentile use the nearest rank: the value at position
// ceil(p * n) of the sorted sample. Both are null with no sample.
//
// Delivery and the weekly counts are the pilot's measures
// (agent-work-phase-1.html, Release gates). Nothing here decides the pilot: a
// person reads the figures and decides.
import type { WorkOutcomesGetOutput } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { type WorkFact, type WorkItemProjection, sortFacts } from "@oxagen/work/records";
import { type RunCost, costOf, doneAtOf } from "./derive";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
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

/** One send a person made in the window, and what the runtime did with it. */
export interface SendOutcome {
  /** When the person sent it: its send_requested fact. */
  requestedAt: string;
  /** The runtime's first claim, or null with none. */
  claimedAt: string | null;
  /** The send has a send_rejected fact. */
  rejected: boolean;
  /** The send has a send_withdrawn fact. */
  withdrawn: boolean;
}

/** One UTC week's intake, counted by the database. */
export interface WeekIntake {
  /** The Monday the week starts, as YYYY-MM-DD in UTC. */
  week: string;
  /** Items Oxagen created in the week, collected from a provider or entered by a person. */
  entered: number;
  /** Sends a person made in the week. */
  sent: number;
}

export interface OutcomesInput {
  now: Date;
  days: number;
  items: readonly OutcomeItem[];
  runs: ReadonlyMap<string, RunCost>;
  /** Sends a person made in the window, each with what the runtime did. */
  sends: readonly SendOutcome[];
  /** More sends were made in the window than read.ts read. */
  sendsTruncated: boolean;
  /** Items entered and sends made in each UTC week of the window, counted by the database. */
  intake: readonly WeekIntake[];
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

/** Whether the send that finished at `doneAt` was reverted. */
function revertedAt(projection: WorkItemProjection, doneAt: number): boolean {
  return projection.orders.some((order) => {
    const at = doneAtOf(order);
    return order.revert !== null && at !== null && Date.parse(at) === doneAt;
  });
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

/** Each send in one bucket, and the claim time over the claimed sends. Pure. */
function countDelivery(sends: readonly SendOutcome[], truncated: boolean): WorkOutcomesGetOutput["delivery"] {
  let claimed = 0;
  let rejected = 0;
  let withdrawn = 0;
  let waiting = 0;
  const minutes: number[] = [];
  for (const send of sends) {
    if (send.rejected) {
      rejected += 1;
    } else if (send.claimedAt !== null) {
      claimed += 1;
      const gap = (Date.parse(send.claimedAt) - Date.parse(send.requestedAt)) / MINUTE_MS;
      if (gap >= 0) minutes.push(gap);
    } else if (send.withdrawn) {
      withdrawn += 1;
    } else {
      waiting += 1;
    }
  }
  minutes.sort((a, b) => a - b);
  return {
    sends: sends.length,
    claimed,
    rejected,
    withdrawn,
    waiting,
    claim_minutes: { median: nearestRank(minutes, 0.5), p90: nearestRank(minutes, 0.9), sample: minutes.length },
    truncated,
  };
}

/** One accepted item in the window, with its done time and lead time. */
interface Accepted {
  item: OutcomeItem;
  doneAt: number;
  /** Hours from the first source reading to the done time, or null when it cannot be measured. */
  leadHours: number | null;
}

/** Count what the work finished in the window, from the items and sends read. read.ts adds whether a read stopped at its cap. Pure. */
export function computeOutcomes(input: OutcomesInput): Omit<WorkOutcomesGetOutput, "truncated"> {
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
  let reverted = 0;
  let waiting = 0;
  for (const item of input.items) {
    const times = doneTimes(item.projection);
    if (times.some((time) => time > waitFrom && time <= end)) waiting += 1;
    const doneAt = latestWithin(times, cohortFrom, waitFrom);
    if (doneAt === null) continue;
    cohort += 1;
    if (item.facts.some((fact) => fact.kind === "reopened" && Date.parse(fact.occurredAt) > doneAt)) reopened += 1;
    // Bound to the send, not to a time: a merge seen before review can be
    // reverted before the acceptance that sets the done time.
    if (revertedAt(item.projection, doneAt)) reverted += 1;
  }

  const intakeOf = new Map(input.intake.map((row) => [row.week, row]));
  const weeks = weeksBetween(new Date(start), input.now).map((week) => {
    const weekEnd = week.getTime() + 7 * DAY_MS - 1;
    const from = Math.max(week.getTime(), start);
    const to = Math.min(weekEnd, end);
    const inWeek = accepted.filter((entry) => within(entry.doneAt, from, to));
    const weekLeads = inWeek.flatMap((entry) => (entry.leadHours === null ? [] : [entry.leadHours])).sort((a, b) => a - b);
    const day = isoDay(week);
    const intake = intakeOf.get(day);
    return {
      week: day,
      accepted_merged: inWeek.length,
      returned: returnedAt.filter((at) => within(at, from, to)).length,
      median_lead_hours: nearestRank(weekLeads, 0.5),
      entered: intake?.entered ?? 0,
      sent: intake?.sent ?? 0,
      full_flow: inWeek.length > 0,
      complete: from === week.getTime() && to === weekEnd,
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
    reverts: { cohort, reverted, waiting },
    delivery: countDelivery(input.sends, input.sendsTruncated),
    weeks,
  };
}
