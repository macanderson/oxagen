import { spendPerMergedPr } from "@oxagen/oxagen/contracts/spend.per_merged_pr";
import { describe, expect, it, vi } from "vitest";
import {
  createSpendPerMergedPrHandler,
  type PerMergedPrRow,
} from "./spend.per_merged_pr";
import { ctx, SCOPE } from "./spend.test-support";

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const AGENT = "acme.core.builder";
const MERGED_AT = new Date("2026-09-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const USD = (dollars: number) => BigInt(dollars) * 1_000_000n;

function runId(n: number): string {
  return `tse_${String(n).padStart(22, "0")}`;
}

/** One joined row: run `n` and its pull request `pr`, merged unless the test says otherwise. */
function row(
  n: number,
  pr: number,
  over: Partial<PerMergedPrRow> = {},
): PerMergedPrRow {
  return {
    runId: runId(n),
    agentKey: AGENT,
    startedAt: new Date("2026-09-08T09:00:00.000Z"),
    costMicros: USD(10),
    currency: "USD",
    costBasis: "gateway_observed",
    prKey: `github:acme/core#${pr}`,
    url: `https://github.com/acme/core/pull/${pr}`,
    prState: "merged",
    merged: true,
    mergedAt: MERGED_AT,
    reverted: false,
    revertedAt: null,
    ...over,
  };
}

const closed = { prState: "closed" as const, merged: false, mergedAt: null };

function harness(rows: PerMergedPrRow[]) {
  const readRows = vi.fn(async () => rows);
  return { readRows, handler: createSpendPerMergedPrHandler({ readRows }) };
}

describe("get_spend_per_merged_pr handler", () => {
  it("reads the period's runs by start day, the last day included", async () => {
    const { readRows, handler } = harness([]);
    const out = await handler({ period: PERIOD }, ctx());
    expect(out).toEqual({ period: PERIOD, agents: [] });
    expect(readRows).toHaveBeenCalledWith(SCOPE, {
      start: new Date("2026-09-01T00:00:00.000Z"),
      end: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  it("answers $20 per merged PR for $40 on 4 bounded runs and 2 merged PRs", async () => {
    const { handler } = harness([
      row(1, 1),
      row(2, 2),
      row(3, 3, closed),
      row(4, 4, { prState: "open", merged: false, mergedAt: null }),
    ]);
    const out = spendPerMergedPr.output.parse(
      await handler({ period: PERIOD }, ctx()),
    );
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]).toMatchObject({
      agentKey: AGENT,
      boundedRuns: 4,
      mergedPrs: 2,
      spend: { micros: "40000000", currency: "USD", basis: "gateway_observed" },
      perMergedPr: {
        micros: "20000000",
        currency: "USD",
        basis: "gateway_observed",
      },
      absence: null,
    });
  });

  it("counts a run the join returns once per pull request as one run", async () => {
    // The join gives one row per pull request, so run 1 arrives twice.
    const { handler } = harness([row(1, 1), row(1, 2), row(2, 3, closed)]);
    const out = await handler({ period: PERIOD }, ctx());
    expect(out.agents[0]).toMatchObject({
      boundedRuns: 2,
      mergedPrs: 2,
      spend: { micros: "20000000" },
      perMergedPr: { micros: "10000000" },
    });
    const first = out.agents[0]?.runs.find((r) => r.runId === runId(1));
    expect(first?.pullRequests.map((p) => p.prKey)).toEqual([
      "github:acme/core#1",
      "github:acme/core#2",
    ]);
  });

  it("does not count a pull request reverted within 14 days as merged", async () => {
    const { handler } = harness([
      row(1, 1),
      row(2, 2, {
        reverted: true,
        revertedAt: new Date(MERGED_AT.getTime() + 2 * DAY_MS),
      }),
    ]);
    const out = await handler({ period: PERIOD }, ctx());
    expect(out.agents[0]).toMatchObject({
      boundedRuns: 2,
      mergedPrs: 1,
      perMergedPr: { micros: "20000000" },
    });
    const states = out.agents[0]?.runs.flatMap((r) =>
      r.pullRequests.map((p) => p.state),
    );
    expect(states).toContain("reverted");
  });

  it("answers absent for an agent with no merged PR", async () => {
    const { handler } = harness([row(1, 1, closed), row(2, 2, closed)]);
    const out = spendPerMergedPr.output.parse(
      await handler({ period: PERIOD }, ctx()),
    );
    expect(out.agents[0]).toMatchObject({
      boundedRuns: 2,
      mergedPrs: 0,
      spend: { micros: "20000000" },
      perMergedPr: null,
      absence: "no_merged_pr",
    });
  });

  it("writes each run's start and cost on the wire", async () => {
    const { handler } = harness([
      row(1, 1, { costMicros: null, costBasis: null }),
      row(2, 2),
    ]);
    const out = await handler({ period: PERIOD }, ctx());
    expect(out.agents[0]?.unpricedRuns).toBe(1);
    expect(out.agents[0]?.runs).toEqual([
      {
        runId: runId(2),
        startedAt: "2026-09-08T09:00:00.000Z",
        cost: {
          micros: "10000000",
          currency: "USD",
          basis: "gateway_observed",
        },
        pullRequests: [
          {
            prKey: "github:acme/core#2",
            url: "https://github.com/acme/core/pull/2",
            state: "merged",
          },
        ],
      },
      {
        runId: runId(1),
        startedAt: "2026-09-08T09:00:00.000Z",
        cost: null,
        pullRequests: [
          {
            prKey: "github:acme/core#1",
            url: "https://github.com/acme/core/pull/1",
            state: "merged",
          },
        ],
      },
    ]);
  });
});
