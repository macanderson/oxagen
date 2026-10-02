/**
 * The work orders whose runs keep ending with no outcome (F34, #5085): a send
 * goes back when its newest NO_OUTCOME_STREAK runs each ended with nothing
 * kept, and stays when any of them landed, is still open, or has no outcome
 * read yet. Every read is a fake, so no module is mocked.
 */
import { describe, expect, it } from "vitest";
import { REVERT_WINDOW_DAYS } from "./findings/spend-with-no-outcome";
import {
  blankOutcome,
  OUTCOME_WINDOW_DAYS,
  type OutcomeRow,
} from "./run-pr-outcomes";
import {
  findWorkOrderSendBacks,
  NO_OUTCOME_STREAK,
  type SendBackDeps,
  type SendBackOrder,
  type SendBackRunTotal,
  workOrderSendBack,
} from "./work-order-send-back";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000f034",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000cf034",
};
const NOW = new Date("2026-10-02T12:00:00.000Z");
const ORDER: SendBackOrder = {
  orderId: "0192d4a8-7c1e-7a00-8000-0000000500a1",
  orderPublicId: "wo_0000000000000000000000a1",
  itemId: "0192d4a8-7c1e-7a00-8000-0000000017a1",
};
const OTHER: SendBackOrder = {
  orderId: "0192d4a8-7c1e-7a00-8000-0000000500b2",
  orderPublicId: "wo_0000000000000000000000b2",
  itemId: "0192d4a8-7c1e-7a00-8000-0000000017b2",
};
const AGENT = "acme.core.builder";
const USD = (cents: number) => BigInt(cents) * 10_000n;

let seq = 0;

/** A run of a send that started `hoursAgo` before NOW. */
function run(
  order: SendBackOrder,
  hoursAgo: number,
  over: Partial<SendBackRunTotal> = {},
): SendBackRunTotal {
  seq += 1;
  return {
    runId: `tse_f34${String(seq).padStart(18, "0")}`,
    workOrderId: order.orderId,
    agentKey: AGENT,
    startedAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000),
    costMicros: USD(250),
    currency: "USD",
    costBasis: "gateway_observed",
    ...over,
  };
}

/** A pull request the run opened, with what it became. */
function pr(runId: string, number: number, over: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    ...blankOutcome(runId, "tacho", {
      provider: "github",
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
    }),
    prState: "closed",
    prStateReadAt: NOW,
    closedAt: NOW,
    ...over,
  };
}

const MERGED_AT = new Date("2026-09-30T12:00:00.000Z");
const closed = (runId: string, n: number) => pr(runId, n);
const merged = (runId: string, n: number) =>
  pr(runId, n, { prState: "merged", merged: true, mergedAt: MERGED_AT });
const reverted = (runId: string, n: number, days = 2) =>
  pr(runId, n, {
    prState: "merged",
    merged: true,
    mergedAt: MERGED_AT,
    reverted: true,
    revertedBy: `github:acme/app#${n + 1000}`,
    revertedAt: new Date(MERGED_AT.getTime() + days * DAY_MS),
    revertedReadAt: NOW,
  });
const open = (runId: string, n: number) =>
  pr(runId, n, { prState: "open", closedAt: null });
const abandoned = (runId: string): OutcomeRow => ({
  ...blankOutcome(runId, "tacho", null),
  terminalReason: "abandoned",
  terminalReasonReadAt: NOW,
});

function byRun(rows: readonly OutcomeRow[]): Map<string, OutcomeRow[]> {
  const map = new Map<string, OutcomeRow[]>();
  for (const row of rows) map.set(row.runId, [...(map.get(row.runId) ?? []), row]);
  return map;
}

describe("workOrderSendBack", () => {
  it("proposes a streak of 3", () => {
    expect(NO_OUTCOME_STREAK).toBe(3);
  });

  it("sends back a work order whose 3 runs in a row ended with no outcome, with each run's spend", () => {
    const a = run(ORDER, 30, { costMicros: USD(410) });
    const b = run(ORDER, 20, { costMicros: USD(824) });
    const c = run(ORDER, 10, { costMicros: null, costBasis: null });
    const found = workOrderSendBack(
      ORDER,
      [a, b, c],
      byRun([closed(a.runId, 1), reverted(b.runId, 2), abandoned(c.runId)]),
    );
    expect(found).toEqual({
      ...ORDER,
      agentKey: AGENT,
      runs: [
        { runId: c.runId, startedAt: c.startedAt, reason: "abandoned", cost: null },
        {
          runId: b.runId,
          startedAt: b.startedAt,
          reason: "reverted",
          cost: { micros: USD(824), currency: "USD", basis: "gateway_observed" },
        },
        {
          runId: a.runId,
          startedAt: a.startedAt,
          reason: "closed_unmerged",
          cost: { micros: USD(410), currency: "USD", basis: "gateway_observed" },
        },
      ],
    });
  });

  it("does not send back a work order with one merged run among its last 3", () => {
    const a = run(ORDER, 30);
    const b = run(ORDER, 20);
    const c = run(ORDER, 10);
    expect(
      workOrderSendBack(ORDER, [a, b, c], byRun([closed(a.runId, 1), merged(b.runId, 2), closed(c.runId, 3)])),
    ).toBeNull();
  });

  it("does not send back a work order whose only run merged", () => {
    const a = run(ORDER, 10);
    expect(workOrderSendBack(ORDER, [a], byRun([merged(a.runId, 1)]))).toBeNull();
  });

  it("needs 3 runs: two runs with no outcome stay", () => {
    const a = run(ORDER, 20);
    const b = run(ORDER, 10);
    expect(workOrderSendBack(ORDER, [a, b], byRun([closed(a.runId, 1), closed(b.runId, 2)]))).toBeNull();
  });

  it("reads only the newest 3: an older merged run does not hold the work order", () => {
    const old = run(ORDER, 40);
    const a = run(ORDER, 30);
    const b = run(ORDER, 20);
    const c = run(ORDER, 10);
    const found = workOrderSendBack(
      ORDER,
      [c, old, a, b],
      byRun([merged(old.runId, 9), closed(a.runId, 1), closed(b.runId, 2), closed(c.runId, 3)]),
    );
    expect(found?.runs.map((r) => r.runId)).toEqual([c.runId, b.runId, a.runId]);
  });

  it("waits while a run in the streak is still open or has no outcome read", () => {
    const a = run(ORDER, 30);
    const b = run(ORDER, 20);
    const c = run(ORDER, 10);
    expect(
      workOrderSendBack(ORDER, [a, b, c], byRun([closed(a.runId, 1), open(b.runId, 2), closed(c.runId, 3)])),
    ).toBeNull();
    expect(workOrderSendBack(ORDER, [a, b, c], byRun([closed(a.runId, 1), closed(b.runId, 2)]))).toBeNull();
  });

  it("counts a revert after the window as a merge that stayed", () => {
    const a = run(ORDER, 30);
    const b = run(ORDER, 20);
    const c = run(ORDER, 10);
    expect(
      workOrderSendBack(
        ORDER,
        [a, b, c],
        byRun([closed(a.runId, 1), reverted(b.runId, 2, REVERT_WINDOW_DAYS + 1), closed(c.runId, 3)]),
      ),
    ).toBeNull();
  });

  it("does not count a run that ended without opening a pull request and was not abandoned", () => {
    const a = run(ORDER, 30);
    const b = run(ORDER, 20);
    const c = run(ORDER, 10);
    const ended: OutcomeRow = { ...abandoned(c.runId), terminalReason: "completed" };
    expect(
      workOrderSendBack(ORDER, [a, b, c], byRun([closed(a.runId, 1), closed(b.runId, 2), ended])),
    ).toBeNull();
  });

  it("reads only the work order's own runs", () => {
    const a = run(ORDER, 30);
    const b = run(ORDER, 20);
    const theirs = run(OTHER, 10);
    expect(
      workOrderSendBack(ORDER, [a, b, theirs], byRun([closed(a.runId, 1), closed(b.runId, 2), closed(theirs.runId, 3)])),
    ).toBeNull();
  });
});

describe("findWorkOrderSendBacks", () => {
  function fakeDeps(
    runs: SendBackRunTotal[],
    openOrders: SendBackOrder[],
    outcomes: OutcomeRow[],
  ) {
    const calls = {
      window: [] as [Date, Date][],
      orderIds: [] as string[][],
      runIds: [] as string[][],
    };
    const deps: SendBackDeps = {
      async readSendRuns(scope, since, until) {
        expect(scope).toEqual(SCOPE);
        calls.window.push([since, until]);
        return runs;
      },
      async readOpenOrders(scope, orderIds) {
        expect(scope).toEqual(SCOPE);
        calls.orderIds.push([...orderIds]);
        return openOrders.filter((order) => orderIds.includes(order.orderId));
      },
      async readOutcomes(scope, runIds) {
        expect(scope).toEqual(SCOPE);
        calls.runIds.push([...runIds]);
        return outcomes.filter((row) => runIds.includes(row.runId));
      },
    };
    return { deps, calls };
  }

  it("reads the outcome window, and returns each open send whose last 3 runs ended with no outcome", async () => {
    const mine = [run(ORDER, 30), run(ORDER, 20), run(ORDER, 10)];
    const theirs = [run(OTHER, 30), run(OTHER, 20), run(OTHER, 10)];
    const { deps, calls } = fakeDeps(
      [...mine, ...theirs],
      [ORDER, OTHER],
      [
        ...mine.map((r, i) => closed(r.runId, i + 1)),
        closed(theirs[0]!.runId, 11),
        merged(theirs[1]!.runId, 12),
        closed(theirs[2]!.runId, 13),
      ],
    );
    const found = await findWorkOrderSendBacks(SCOPE, NOW, deps);
    expect(found.map((f) => f.orderId)).toEqual([ORDER.orderId]);
    expect(found[0]!.runs).toHaveLength(3);
    expect(calls.window).toEqual([[new Date(NOW.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS), NOW]]);
  });

  it("asks for orders only when a send has 3 runs, and outcomes only for each streak", async () => {
    const old = run(ORDER, 40);
    const streak = [run(ORDER, 30), run(ORDER, 20), run(ORDER, 10)];
    const few = [run(OTHER, 20), run(OTHER, 10)];
    const { deps, calls } = fakeDeps(
      [old, ...streak, ...few],
      [ORDER, OTHER],
      [closed(old.runId, 9), ...streak.map((r, i) => closed(r.runId, i + 1))],
    );
    await findWorkOrderSendBacks(SCOPE, NOW, deps);
    expect(calls.orderIds).toEqual([[ORDER.orderId]]);
    expect(calls.runIds).toEqual([streak.map((r) => r.runId).reverse()]);
  });

  it("leaves out a send that is closed, and reads nothing more when no send qualifies", async () => {
    const streak = [run(ORDER, 30), run(ORDER, 20), run(ORDER, 10)];
    const closedSend = fakeDeps(streak, [], streak.map((r, i) => closed(r.runId, i + 1)));
    expect(await findWorkOrderSendBacks(SCOPE, NOW, closedSend.deps)).toEqual([]);
    expect(closedSend.calls.runIds).toEqual([]);

    const none = fakeDeps([run(ORDER, 10)], [ORDER], []);
    expect(await findWorkOrderSendBacks(SCOPE, NOW, none.deps)).toEqual([]);
    expect(none.calls.orderIds).toEqual([]);
  });

  it("returns sends in public id order", async () => {
    const mine = [run(ORDER, 30), run(ORDER, 20), run(ORDER, 10)];
    const theirs = [run(OTHER, 30), run(OTHER, 20), run(OTHER, 10)];
    const { deps } = fakeDeps(
      [...theirs, ...mine],
      [OTHER, ORDER],
      [...mine, ...theirs].map((r, i) => closed(r.runId, i + 1)),
    );
    const found = await findWorkOrderSendBacks(SCOPE, NOW, deps);
    expect(found.map((f) => f.orderPublicId)).toEqual([ORDER.orderPublicId, OTHER.orderPublicId]);
  });
});
