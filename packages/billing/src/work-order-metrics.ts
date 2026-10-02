/**
 * work-order-metrics.ts: the operator metrics, the work order metrics, and
 * unassigned spend, per week (spend spec, Operator productivity; F33). This
 * module is the pure fold. The handler `get_work_order_metrics` reads the
 * rows and the operator ranking reads the same split for its unassigned
 * share.
 *
 * Every run has a parent work order (F13): a send in `work.orders`, or a
 * direct work order in `work.direct_orders` for a run started outside Oxagen.
 *
 * - Done (decision 5). A work order is done at its first passing check run
 *   of its definition of done. Only a send has a definition of done, so a
 *   direct work order is never done. A person who reopens the work item or
 *   returns the work order after the passing check adds to the reopen rate.
 * - Unassigned spend (decisions 3 and 4). Spend on a run whose direct work
 *   order has no work item. A direct work order attached to a work item
 *   within 24 hours of its first run counts as assigned from that run. One
 *   attached later counts as assigned from the attachment on, so the frames
 *   before it stay unassigned. Unassigned spend is its own line: it never
 *   adds to unproductive spend.
 * - Frame time. Spend and unassigned spend count each frame by the time it
 *   ran, as the unproductive share does. A run whose frames all fall inside
 *   one part of a window adds its whole cost. Any other run is priced frame
 *   by frame through the segments `runSegmentsToPrice` lists.
 * - Work order spend. Cost to done, rework spend, and abandoned spend add
 *   whole runs of the work order, picked by when each run started against
 *   the work order's check runs.
 */
import type { TokenCounts } from "./cost-rollup";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One week, Monday 00:00 UTC to the next Monday. */
export const METRIC_WEEK_MS = 7 * DAY_MS;

/**
 * Decision 4: a direct work order attached to a work item within this many
 * hours of its first run counts as assigned from that run. One window for
 * every workspace.
 */
export const DIRECT_ORDER_GRACE_HOURS = 24;
export const DIRECT_ORDER_GRACE_MS = DIRECT_ORDER_GRACE_HOURS * HOUR_MS;

/** A done work order reopened or returned within this many days of its passing check adds to the reopen rate. */
export const REOPEN_WINDOW_DAYS = 14;
const REOPEN_WINDOW_MS = REOPEN_WINDOW_DAYS * DAY_MS;

/** At most this many work orders and runs are cited under one figure. */
export const METRIC_EVIDENCE_MAX = 10;

/** A half-open span of time: `start` inclusive, `end` exclusive. */
export interface MetricSpan {
  start: Date;
  end: Date;
}

/** One week the metrics cover: its Monday and Sunday as `YYYY-MM-DD`, and its span. */
export interface MetricWeek extends MetricSpan {
  from: string;
  to: string;
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The whole weeks, Monday to Sunday in UTC, that overlap the day range
 * `from` to `to`, oldest first. Each week is whole even where the range
 * starts or ends inside it, so every week's figures compare with the others.
 */
export function weeksOverlapping(from: string, to: string): MetricWeek[] {
  const first = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()))
    throw new RangeError(`not a YYYY-MM-DD range: ${from} to ${to}`);
  // getUTCDay is 0 on Sunday; a Monday is 0 days into its week.
  const intoWeek = (first.getUTCDay() + 6) % 7;
  let start = first.getTime() - intoWeek * DAY_MS;
  const weeks: MetricWeek[] = [];
  while (start <= last.getTime()) {
    const end = start + METRIC_WEEK_MS;
    weeks.push({
      from: isoDay(new Date(start)),
      to: isoDay(new Date(end - DAY_MS)),
      start: new Date(start),
      end: new Date(end),
    });
    start = end;
  }
  return weeks;
}

/**
 * Whether a week's figures are final: the grace window has run out for every
 * run in it (decision 4), so no attachment can still move its spend. A
 * week's figures settle a day after it ends.
 */
export function weekSettled(week: MetricSpan, now: Date): boolean {
  return now.getTime() >= week.end.getTime() + DIRECT_ORDER_GRACE_MS;
}

/** A direct work order's first run and its attachment to a work item. */
export interface DirectOrderAttachment {
  /** When the direct work order's first run started. */
  openedAt: Date;
  /** When a person attached it to a work item; null while unattached. */
  attachedAt: Date | null;
}

/**
 * When a direct work order's spend counts as assigned (decision 4): from its
 * first run when it was attached within 24 hours of that run, from the
 * attachment when later, and never while it is unattached (null).
 */
export function assignedFrom(order: DirectOrderAttachment): Date | null {
  if (order.attachedAt === null) return null;
  const after = order.attachedAt.getTime() - order.openedAt.getTime();
  return after <= DIRECT_ORDER_GRACE_MS ? order.openedAt : order.attachedAt;
}

/** How a run's work order is assigned to a work item. */
export type RunAssignment =
  /** A send: it went out for a work item, so the run is assigned from its start. */
  | { kind: "send" }
  /** A direct work order, assigned from `from` (`assignedFrom`); never while `from` is null. */
  | { kind: "direct"; from: Date | null }
  /** No work order recorded: the run was rolled up before F13 and not since. */
  | { kind: "not_recorded" };

/** One run as the spend split reads it. */
export interface MetricRun {
  runId: string;
  /** The operator's principal public id (`prn_…`); null when the run names none. */
  operatorKey: string | null;
  /** `org_ns.ws_ns.slug`; null when the run names no agent. */
  agentKey: string | null;
  startedAt: Date;
  /** The latest instant a priced frame of the run can carry: its seal, or its last rollup. */
  lastFrameAt: Date;
  /** The run's priced cost; null when no frame was priced. */
  costMicros: bigint | null;
  currency: string;
  /** The run's tokens over every token class (`tokenTotal`). */
  tokens: number;
  assignment: RunAssignment;
  /** Whether the run's work order is a send whose work item has a definition of done. */
  definitionOfDone: boolean;
}

/** The token classes a token total adds. A server tool request is a count of requests, not tokens. */
const TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
] as const;

/** The tokens of one run or frame over every token class; an absent class adds 0. */
export function tokenTotal(tokens: Partial<TokenCounts> | null | undefined): number {
  if (!tokens) return 0;
  let total = 0;
  for (const cls of TOKEN_CLASSES) {
    const n = tokens[cls];
    if (typeof n === "number" && Number.isFinite(n)) total += n;
  }
  return total;
}

function contains(span: MetricSpan, run: MetricRun): boolean {
  return (
    run.startedAt.getTime() >= span.start.getTime() &&
    run.lastFrameAt.getTime() < span.end.getTime()
  );
}

function misses(span: MetricSpan, run: MetricRun): boolean {
  return (
    span.end.getTime() <= span.start.getTime() ||
    run.lastFrameAt.getTime() < span.start.getTime() ||
    run.startedAt.getTime() >= span.end.getTime()
  );
}

/** The part of `window` before the run counts as assigned; null when no part is unassigned. */
function unassignedSpan(run: MetricRun, window: MetricSpan): MetricSpan | null {
  if (run.assignment.kind !== "direct") return null;
  const from = run.assignment.from;
  const end =
    from === null
      ? window.end
      : new Date(Math.min(window.end.getTime(), from.getTime()));
  if (end.getTime() <= window.start.getTime()) return null;
  return { start: window.start, end };
}

/** The key a priced segment is stored under. */
export function segmentKey(runId: string, span: MetricSpan): string {
  return `${runId}|${span.start.getTime()}|${span.end.getTime()}`;
}

/**
 * The spans of one run whose frames must be priced one by one: each window
 * the run crosses the edge of, and each unassigned part of a window the run
 * crosses the edge of. A run that falls wholly inside a span, or wholly
 * outside it, needs no frames there. Empty when the run needs no frame read.
 */
export function runSegmentsToPrice(
  run: MetricRun,
  windows: readonly MetricSpan[],
): MetricSpan[] {
  if (run.costMicros === null) return [];
  const out = new Map<string, MetricSpan>();
  for (const window of windows) {
    if (misses(window, run)) continue;
    if (!contains(window, run))
      out.set(segmentKey(run.runId, window), window);
    const part = unassignedSpan(run, window);
    if (part !== null && !misses(part, run) && !contains(part, run))
      out.set(segmentKey(run.runId, part), part);
  }
  return [...out.values()];
}

/** What a segment's frames came to. */
export interface PricedSegment {
  micros: bigint;
  tokens: number;
}

/**
 * The priced segments by `segmentKey`. A segment whose frames could not be
 * read or priced holds null, and one missing from the map counts the same.
 */
export type PricedSegments = ReadonlyMap<string, PricedSegment | null>;

/** One run's spend inside one window. */
export interface RunWindowSpend {
  runId: string;
  operatorKey: string | null;
  agentKey: string | null;
  currency: string;
  /** Null when the run crosses the window's edge and its frames were not priced. */
  spend: bigint | null;
  /** The unassigned part; 0 for a run that is not on an unassigned direct work order. */
  unassigned: bigint | null;
  unassignedTokens: number | null;
  /** The part on a send with a definition of done (the cost per done numerator). */
  definitionOfDone: bigint | null;
  notRecorded: bigint | null;
}

/**
 * Split each run's spend over the windows, by frame time. A window with no
 * frame of the run gets no row. Runs with no price are left out, as the
 * frame-time spend leaves them out.
 */
export function splitRunSpend(
  runs: readonly MetricRun[],
  windows: readonly MetricSpan[],
  priced: PricedSegments,
): RunWindowSpend[][] {
  const out: RunWindowSpend[][] = windows.map(() => []);
  for (const run of runs) {
    if (run.costMicros === null) continue;
    const cost = run.costMicros;
    windows.forEach((window, i) => {
      if (misses(window, run)) return;
      const lookup = (span: MetricSpan): PricedSegment | null =>
        priced.get(segmentKey(run.runId, span)) ?? null;
      const spendPart = contains(window, run)
        ? { micros: cost, tokens: run.tokens }
        : lookup(window);
      const part = unassignedSpan(run, window);
      let unassigned: PricedSegment | null;
      if (part === null || misses(part, run))
        unassigned = { micros: 0n, tokens: 0 };
      else if (contains(part, run))
        unassigned = { micros: cost, tokens: run.tokens };
      else unassigned = lookup(part);
      const spend = spendPart?.micros ?? null;
      out[i]?.push({
        runId: run.runId,
        operatorKey: run.operatorKey,
        agentKey: run.agentKey,
        currency: run.currency,
        spend,
        unassigned: unassigned?.micros ?? null,
        unassignedTokens: unassigned?.tokens ?? null,
        definitionOfDone: run.definitionOfDone ? spend : 0n,
        notRecorded: run.assignment.kind === "not_recorded" ? spend : 0n,
      });
    });
  }
  return out;
}

/** A sum of money that is null when any part is unknown or in another currency. */
export interface SpendSum {
  spend: bigint | null;
  unassigned: bigint | null;
  unassignedTokens: number | null;
  definitionOfDone: bigint | null;
  notRecorded: bigint | null;
  /** The runs with unassigned spend, largest unassigned part first, at most `METRIC_EVIDENCE_MAX`. */
  unassignedRuns: { runId: string; micros: bigint }[];
}

function addOrNull(held: bigint | null, add: bigint | null): bigint | null {
  return held === null || add === null ? null : held + add;
}

/** Sum the run rows in `currency`. A row in another currency makes every money figure null. */
export function sumRunSpend(
  rows: readonly RunWindowSpend[],
  currency: string,
): SpendSum {
  let spend: bigint | null = 0n;
  let unassigned: bigint | null = 0n;
  let tokens: number | null = 0;
  let dod: bigint | null = 0n;
  let notRecorded: bigint | null = 0n;
  const runs: { runId: string; micros: bigint }[] = [];
  for (const row of rows) {
    if (row.currency !== currency) {
      spend = unassigned = dod = notRecorded = null;
      tokens = null;
      break;
    }
    spend = addOrNull(spend, row.spend);
    unassigned = addOrNull(unassigned, row.unassigned);
    dod = addOrNull(dod, row.definitionOfDone);
    notRecorded = addOrNull(notRecorded, row.notRecorded);
    tokens =
      tokens === null || row.unassignedTokens === null
        ? null
        : tokens + row.unassignedTokens;
    if (row.unassigned !== null && row.unassigned > 0n)
      runs.push({ runId: row.runId, micros: row.unassigned });
  }
  runs.sort((a, b) =>
    a.micros !== b.micros
      ? a.micros > b.micros
        ? -1
        : 1
      : a.runId < b.runId
        ? -1
        : 1,
  );
  return {
    spend,
    unassigned,
    unassignedTokens: tokens,
    definitionOfDone: dod,
    notRecorded,
    unassignedRuns: runs.slice(0, METRIC_EVIDENCE_MAX),
  };
}

/** A ratio of two amounts, capped at 1; null when either is unknown or the whole is not positive. */
export function shareOf(
  part: bigint | null,
  whole: bigint | null,
): number | null {
  if (part === null || whole === null || whole <= 0n) return null;
  return Math.min(1, Number(part) / Number(whole));
}

/** One run open for an agent: its start and its last frame. */
export interface OpenRun {
  operatorKey: string | null;
  agentKey: string | null;
  startedAt: Date;
  lastFrameAt: Date;
}

/**
 * Agents in flight: distinct agents with a run open, averaged over the part
 * of the window that has passed. Each agent adds the time at least one of
 * its runs was open, over the length of that part, so two runs of one agent
 * at once count it once. A run with no agent adds nothing.
 */
export function agentsInFlight(
  runs: readonly OpenRun[],
  window: MetricSpan,
  now: Date,
): { average: number; agents: string[] } {
  const until = Math.min(window.end.getTime(), now.getTime());
  const length = until - window.start.getTime();
  if (length <= 0) return { average: 0, agents: [] };
  const byAgent = new Map<string, [number, number][]>();
  for (const run of runs) {
    if (run.agentKey === null) continue;
    const start = Math.max(run.startedAt.getTime(), window.start.getTime());
    const end = Math.min(run.lastFrameAt.getTime(), until);
    if (end <= start) continue;
    const held = byAgent.get(run.agentKey) ?? [];
    held.push([start, end]);
    byAgent.set(run.agentKey, held);
  }
  let open = 0;
  for (const spans of byAgent.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let curStart = -1;
    let curEnd = -1;
    for (const [start, end] of spans) {
      if (start > curEnd) {
        if (curEnd > curStart) open += curEnd - curStart;
        curStart = start;
        curEnd = end;
      } else if (end > curEnd) curEnd = end;
    }
    if (curEnd > curStart) open += curEnd - curStart;
  }
  return { average: open / length, agents: [...byAgent.keys()].sort() };
}

/** A check run's result: held and proven pass, broken fails, and pending has not decided. */
export type MetricCheckResult = "passed" | "failed" | "pending";

/** One check run of a work order's definition of done (`work.done_checks`). */
export interface MetricCheck {
  checkedAt: Date;
  result: MetricCheckResult;
}

/** One run of a work order, as `cost.run_totals` priced it. */
export interface MetricOrderRun {
  runId: string;
  startedAt: Date;
  costMicros: bigint | null;
  currency: string;
}

/** One send as the work order metrics read it. */
export interface MetricOrder {
  id: string;
  /** `wo_…`, the id a person reads. */
  publicId: string;
  /** The principal public id of the person who sent it; null when none resolves. */
  operatorKey: string | null;
  agentKey: string | null;
  /** When it was sent. */
  dispatchedAt: Date;
  closedAt: Date | null;
  /** Whether its work item has a definition of done. Without one it is never done. */
  definitionOfDone: boolean;
  checks: MetricCheck[];
  /** When a person reopened its work item or returned it. */
  rejections: Date[];
  runs: MetricOrderRun[];
}

/** When the work order became done: its first passing check run (decision 5). Null when it has none. */
export function doneAt(order: MetricOrder): Date | null {
  if (!order.definitionOfDone) return null;
  let first: Date | null = null;
  for (const check of order.checks) {
    if (check.result !== "passed") continue;
    if (first === null || check.checkedAt.getTime() < first.getTime())
      first = check.checkedAt;
  }
  return first;
}

/** The first failed check run before `before`; null when none failed first. */
function firstFailedBefore(order: MetricOrder, before: Date): Date | null {
  let first: Date | null = null;
  for (const check of order.checks) {
    if (check.result !== "failed") continue;
    if (check.checkedAt.getTime() >= before.getTime()) continue;
    if (first === null || check.checkedAt.getTime() < first.getTime())
      first = check.checkedAt;
  }
  return first;
}

/** Whether a person reopened or returned the done work order within the reopen window after its passing check. */
export function reopenedAfter(order: MetricOrder, done: Date): boolean {
  return order.rejections.some((at) => {
    const after = at.getTime() - done.getTime();
    return after >= 0 && after <= REOPEN_WINDOW_MS;
  });
}

function inSpan(at: Date | null, span: MetricSpan): at is Date {
  return (
    at !== null &&
    at.getTime() >= span.start.getTime() &&
    at.getTime() < span.end.getTime()
  );
}

/** The ids behind one figure. */
export interface MetricEvidence {
  workOrders: string[];
  runs: string[];
}

/** A count over a count. `value` is null when the denominator is 0. */
export interface RateFigure extends MetricEvidence {
  value: number | null;
  numerator: number;
  denominator: number;
}

/** An amount in the metrics' currency. `micros` is null when there is no figure. */
export interface MoneyFigure extends MetricEvidence {
  micros: bigint | null;
}

/** The seven work order metrics for one group and one window. */
export interface WorkOrderMetricsFold {
  /** Done work orders whose passing check fell in the window. */
  done: number;
  doneRate: RateFigure;
  firstPassRate: RateFigure;
  /** The mean over the window's done work orders of the spend up to the passing check. */
  costToDone: MoneyFigure;
  /** The mean time from dispatch to the passing check, in milliseconds. */
  timeToDone: MetricEvidence & { ms: number | null };
  reworkSpend: MoneyFigure;
  abandonedSpend: MoneyFigure;
  /** `pending` counts done work orders whose reopen window has not ended. */
  reopenRate: RateFigure & { pending: number };
}

class Evidence {
  readonly orders = new Set<string>();
  readonly runs = new Set<string>();
  add(order: MetricOrder, runs: readonly MetricOrderRun[]): void {
    this.orders.add(order.publicId);
    for (const run of runs) this.runs.add(run.runId);
  }
  done(): MetricEvidence {
    return {
      workOrders: [...this.orders].sort().slice(0, METRIC_EVIDENCE_MAX),
      runs: [...this.runs].sort().slice(0, METRIC_EVIDENCE_MAX),
    };
  }
}

class MoneyAdder {
  micros: bigint | null = 0n;
  add(runs: readonly MetricOrderRun[], currency: string): void {
    for (const run of runs) {
      if (this.micros === null) return;
      if (run.costMicros === null) continue;
      if (run.currency !== currency) this.micros = null;
      else this.micros += run.costMicros;
    }
  }
}

function divideRounded(micros: bigint, by: number): bigint {
  const n = BigInt(by);
  // Round half away from zero; spend is never negative.
  return (micros * 2n + n) / (2n * n);
}

function rate(
  numerator: number,
  denominator: number,
  evidence: Evidence,
): RateFigure {
  return {
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
    ...evidence.done(),
  };
}

/**
 * The seven work order metrics over the work orders of one group, for one
 * window. Only work orders with a definition of done count.
 *
 * - Done rate: of the work orders closed in the window, those with a passing
 *   check at or before the close.
 * - First-pass rate: of the work orders done in the window, those with no
 *   failed check run before the passing one. A pending check run is not a
 *   failure.
 * - Cost to done: the runs that started at or before the passing check.
 * - Rework spend: the runs that started after the first failed check run and
 *   at or before the passing one.
 * - Abandoned spend: every run of a work order closed in the window with no
 *   passing check.
 * - Reopen rate: done work orders whose item a person reopened, or that a
 *   person returned, within `REOPEN_WINDOW_DAYS` of the passing check.
 */
export function workOrderMetrics(
  orders: readonly MetricOrder[],
  window: MetricSpan,
  currency: string,
  now: Date,
): WorkOrderMetricsFold {
  const closedEv = new Evidence();
  const doneEv = new Evidence();
  const firstEv = new Evidence();
  const costEv = new Evidence();
  const timeEv = new Evidence();
  const reworkEv = new Evidence();
  const abandonedEv = new Evidence();
  const reopenEv = new Evidence();
  const cost = new MoneyAdder();
  const rework = new MoneyAdder();
  const abandoned = new MoneyAdder();
  let closed = 0;
  let closedDone = 0;
  let done = 0;
  let firstPass = 0;
  let reopened = 0;
  let reopenPending = 0;
  let timeTotal = 0;

  for (const order of orders) {
    if (!order.definitionOfDone) continue;
    const passed = doneAt(order);
    if (inSpan(order.closedAt, window)) {
      closed += 1;
      const closedAt = order.closedAt;
      if (passed !== null && passed.getTime() <= closedAt.getTime()) {
        closedDone += 1;
        closedEv.add(order, order.runs);
      } else {
        abandonedEv.add(order, order.runs);
        abandoned.add(order.runs, currency);
      }
    }
    if (!inSpan(passed, window)) continue;
    done += 1;
    doneEv.add(order, order.runs);
    const failed = firstFailedBefore(order, passed);
    if (failed === null) {
      firstPass += 1;
      firstEv.add(order, order.runs);
    }
    const upToPass = order.runs.filter(
      (r) => r.startedAt.getTime() <= passed.getTime(),
    );
    cost.add(upToPass, currency);
    costEv.add(order, upToPass);
    timeTotal += passed.getTime() - order.dispatchedAt.getTime();
    timeEv.add(order, []);
    if (failed !== null) {
      const reworkRuns = upToPass.filter(
        (r) => r.startedAt.getTime() > failed.getTime(),
      );
      rework.add(reworkRuns, currency);
      reworkEv.add(order, reworkRuns);
    }
    if (reopenedAfter(order, passed)) {
      reopened += 1;
      reopenEv.add(order, order.runs);
    } else if (now.getTime() - passed.getTime() < REOPEN_WINDOW_MS) {
      reopenPending += 1;
    }
  }

  const mean = (sum: bigint | null): bigint | null =>
    sum === null || done === 0 ? null : divideRounded(sum, done);
  // Done rate cites the closed work orders that passed; first pass the done
  // ones that passed first time.
  return {
    done,
    doneRate: rate(closedDone, closed, closedEv),
    firstPassRate: rate(firstPass, done, firstEv),
    costToDone: { micros: mean(cost.micros), ...costEv.done() },
    timeToDone: {
      ms: done === 0 ? null : Math.round(timeTotal / done),
      ...timeEv.done(),
    },
    reworkSpend: { micros: rework.micros, ...reworkEv.done() },
    abandonedSpend: { micros: abandoned.micros, ...abandonedEv.done() },
    reopenRate: { ...rate(reopened, done, reopenEv), pending: reopenPending },
  };
}

/** The work orders done in the window, with the runs of each, for the ranking's done column. */
export function doneWorkOrders(
  orders: readonly MetricOrder[],
  window: MetricSpan,
): { order: MetricOrder; doneAt: Date }[] {
  const out: { order: MetricOrder; doneAt: Date }[] = [];
  for (const order of orders) {
    const passed = doneAt(order);
    if (inSpan(passed, window)) out.push({ order, doneAt: passed });
  }
  return out.sort((a, b) =>
    a.doneAt.getTime() !== b.doneAt.getTime()
      ? a.doneAt.getTime() - b.doneAt.getTime()
      : a.order.publicId < b.order.publicId
        ? -1
        : 1,
  );
}
