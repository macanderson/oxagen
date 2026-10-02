import { describe, expect, it } from "vitest";
import {
  PER_MERGED_PR_RUNS_MAX,
  type PerMergedPrOutcome,
  type PerMergedPrRun,
  perMergedPrState,
  REVERT_WINDOW_DAYS,
  revertedWithinWindow,
  spendPerMergedPr,
} from "./spend-per-merged-pr";

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT = "acme.core.builder";
const OTHER = "acme.core.reviewer";
const MERGED_AT = new Date("2026-09-10T12:00:00.000Z");
const USD = (dollars: number) => BigInt(dollars) * 1_000_000n;

let seq = 0;

function run(over: Partial<PerMergedPrRun> = {}): PerMergedPrRun {
  seq += 1;
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    agentKey: AGENT,
    startedAt: new Date("2026-09-08T09:00:00.000Z"),
    costMicros: USD(10),
    currency: "USD",
    costBasis: "gateway_observed",
    ...over,
  };
}

function pr(
  runId: string,
  number: number,
  over: Partial<PerMergedPrOutcome> = {},
): PerMergedPrOutcome {
  return {
    runId,
    prKey: `github:acme/core#${number}`,
    url: `https://github.com/acme/core/pull/${number}`,
    prState: "closed",
    merged: false,
    mergedAt: null,
    reverted: false,
    revertedAt: null,
    ...over,
  };
}

function merged(
  runId: string,
  number: number,
  over: Partial<PerMergedPrOutcome> = {},
): PerMergedPrOutcome {
  return pr(runId, number, {
    prState: "merged",
    merged: true,
    mergedAt: MERGED_AT,
    ...over,
  });
}

function revertedAfter(ms: number): Partial<PerMergedPrOutcome> {
  return {
    reverted: true,
    revertedAt: new Date(MERGED_AT.getTime() + ms),
  };
}

function none(runId: string): PerMergedPrOutcome {
  return pr(runId, 1, { prKey: "none", url: null, prState: null });
}

describe("spendPerMergedPr", () => {
  it("divides $40 on 4 bounded runs by 2 merged pull requests: $20 each", () => {
    const runs = [run(), run(), run(), run()];
    const [a, b, c, d] = runs.map((r) => r.runId) as [
      string,
      string,
      string,
      string,
    ];
    const [agent] = spendPerMergedPr(runs, [
      merged(a, 1),
      merged(b, 2),
      pr(c, 3),
      pr(d, 4, { prState: "open" }),
    ]);
    expect(agent).toMatchObject({
      agentKey: AGENT,
      boundedRuns: 4,
      unpricedRuns: 0,
      mergedPrs: 2,
      spend: { micros: USD(40), currency: "USD", basis: "gateway_observed" },
      perMergedPr: {
        micros: USD(20),
        currency: "USD",
        basis: "gateway_observed",
      },
      absence: null,
    });
    expect(agent?.runs).toHaveLength(4);
  });

  it(`does not count a pull request reverted within ${REVERT_WINDOW_DAYS} days of its merge`, () => {
    const runs = [run(), run(), run(), run()];
    const [a, b, c, d] = runs.map((r) => r.runId) as [
      string,
      string,
      string,
      string,
    ];
    const [agent] = spendPerMergedPr(runs, [
      merged(a, 1),
      merged(b, 2, revertedAfter(3 * DAY_MS)),
      merged(c, 3),
      pr(d, 4),
    ]);
    expect(agent?.mergedPrs).toBe(2);
    expect(agent?.perMergedPr?.micros).toBe(USD(20));
    const states = agent?.runs.flatMap((r) =>
      r.pullRequests.map((p) => p.state),
    );
    expect(states?.filter((s) => s === "reverted")).toHaveLength(1);
  });

  it("shows absent for an agent whose bounded runs merged nothing", () => {
    const a = run();
    const b = run();
    const [agent] = spendPerMergedPr(
      [a, b],
      [pr(a.runId, 1), merged(b.runId, 2, revertedAfter(DAY_MS))],
    );
    expect(agent).toMatchObject({
      agentKey: AGENT,
      boundedRuns: 2,
      mergedPrs: 0,
      spend: { micros: USD(20) },
      perMergedPr: null,
      absence: "no_merged_pr",
    });
  });

  it("leaves out runs that opened no pull request and runs with no agent", () => {
    const bounded = run();
    const noPr = run();
    const unread = run();
    const noAgent = run({ agentKey: null });
    const result = spendPerMergedPr(
      [bounded, noPr, unread, noAgent],
      [merged(bounded.runId, 1), none(noPr.runId), merged(noAgent.runId, 9)],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      boundedRuns: 1,
      mergedPrs: 1,
      perMergedPr: { micros: USD(10) },
    });
  });

  it("counts a pull request two runs of one agent opened once", () => {
    const a = run();
    const b = run();
    const [agent] = spendPerMergedPr(
      [a, b],
      [merged(a.runId, 7), merged(b.runId, 7)],
    );
    expect(agent?.mergedPrs).toBe(1);
    expect(agent?.perMergedPr?.micros).toBe(USD(20));
  });

  it("figures each agent on its own runs", () => {
    const a = run();
    const b = run({ agentKey: OTHER, costMicros: USD(30) });
    const result = spendPerMergedPr(
      [b, a],
      [merged(a.runId, 1), pr(b.runId, 2)],
    );
    expect(result.map((r) => r.agentKey)).toEqual([AGENT, OTHER]);
    expect(result[0]?.perMergedPr?.micros).toBe(USD(10));
    expect(result[1]).toMatchObject({
      perMergedPr: null,
      absence: "no_merged_pr",
    });
  });

  it("keeps an unpriced run in the count and out of the spend", () => {
    const a = run();
    const b = run({ costMicros: null, costBasis: null });
    const [agent] = spendPerMergedPr(
      [a, b],
      [merged(a.runId, 1), merged(b.runId, 2)],
    );
    expect(agent).toMatchObject({
      boundedRuns: 2,
      unpricedRuns: 1,
      mergedPrs: 2,
      perMergedPr: { micros: USD(5) },
    });
  });

  it("has no figure when no bounded run was priced", () => {
    const a = run({ costMicros: null, costBasis: null });
    const [agent] = spendPerMergedPr([a], [merged(a.runId, 1)]);
    expect(agent).toMatchObject({
      spend: null,
      perMergedPr: null,
      absence: "not_priced",
    });
  });

  it("has no figure when the bounded runs hold two currencies", () => {
    const a = run();
    const b = run({ currency: "EUR" });
    const [agent] = spendPerMergedPr(
      [a, b],
      [merged(a.runId, 1), merged(b.runId, 2)],
    );
    expect(agent).toMatchObject({
      spend: null,
      perMergedPr: null,
      absence: "mixed_currency",
    });
  });

  it("folds the basis of the priced runs", () => {
    const a = run();
    const b = run({ costBasis: "client_attested" });
    const [agent] = spendPerMergedPr([a, b], [merged(a.runId, 1), pr(b.runId, 2)]);
    expect(agent?.perMergedPr?.basis).toBe("mixed");
  });

  it("rounds the figure to the nearest micro", () => {
    const a = run({ costMicros: 10n });
    const [agent] = spendPerMergedPr(
      [a],
      [merged(a.runId, 1), merged(a.runId, 2), merged(a.runId, 3)],
    );
    // 10 / 3 = 3.33 micros
    expect(agent?.perMergedPr?.micros).toBe(3n);
    const b = run({ costMicros: 5n });
    const [other] = spendPerMergedPr(
      [b],
      [merged(b.runId, 1), merged(b.runId, 2)],
    );
    // 5 / 2 = 2.5 micros, rounded half up
    expect(other?.perMergedPr?.micros).toBe(3n);
  });

  it(`lists at most ${PER_MERGED_PR_RUNS_MAX} runs, costliest first`, () => {
    const runs = Array.from({ length: PER_MERGED_PR_RUNS_MAX + 2 }, (_, i) =>
      run({ costMicros: USD(i + 1) }),
    );
    const [agent] = spendPerMergedPr(
      runs,
      runs.map((r, i) => merged(r.runId, i + 1)),
    );
    expect(agent?.boundedRuns).toBe(PER_MERGED_PR_RUNS_MAX + 2);
    expect(agent?.runs).toHaveLength(PER_MERGED_PR_RUNS_MAX);
    expect(agent?.runs[0]?.cost?.micros).toBe(USD(PER_MERGED_PR_RUNS_MAX + 2));
  });
});

describe("revertedWithinWindow", () => {
  const row = (over: Partial<PerMergedPrOutcome>) =>
    merged("tse_0000000000000000000001", 1, over);

  it(`counts a revert ${REVERT_WINDOW_DAYS} days after the merge, the last day included`, () => {
    expect(revertedWithinWindow(row(revertedAfter(REVERT_WINDOW_DAYS * DAY_MS)))).toBe(
      true,
    );
  });

  it("counts a revert at the merge instant", () => {
    expect(revertedWithinWindow(row(revertedAfter(0)))).toBe(true);
  });

  it(`does not count a revert later than ${REVERT_WINDOW_DAYS} days`, () => {
    expect(
      revertedWithinWindow(row(revertedAfter(REVERT_WINDOW_DAYS * DAY_MS + 1))),
    ).toBe(false);
  });

  it("does not count a revert dated before its merge", () => {
    expect(revertedWithinWindow(row(revertedAfter(-1)))).toBe(false);
  });

  it("does not count a revert with no time, or a merge with no time", () => {
    expect(revertedWithinWindow(row({ reverted: true, revertedAt: null }))).toBe(
      false,
    );
    expect(
      revertedWithinWindow(
        row({ mergedAt: null, ...revertedAfter(DAY_MS) }),
      ),
    ).toBe(false);
  });
});

describe("perMergedPrState", () => {
  const id = "tse_0000000000000000000001";

  it("reads each state", () => {
    expect(perMergedPrState(merged(id, 1))).toBe("merged");
    expect(perMergedPrState(merged(id, 1, revertedAfter(DAY_MS)))).toBe(
      "reverted",
    );
    expect(
      perMergedPrState(
        merged(id, 1, revertedAfter((REVERT_WINDOW_DAYS + 1) * DAY_MS)),
      ),
    ).toBe("merged");
    expect(perMergedPrState(pr(id, 1))).toBe("closed");
    expect(perMergedPrState(pr(id, 1, { prState: "open" }))).toBe("open");
    expect(perMergedPrState(pr(id, 1, { prState: null }))).toBe("unread");
  });

  it("reads a row whose merged flag is set before its state as merged", () => {
    expect(perMergedPrState(pr(id, 1, { prState: null, merged: true }))).toBe(
      "merged",
    );
  });
});
