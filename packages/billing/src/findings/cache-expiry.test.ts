// cache-expiry.test.ts — idle cache rewrites (detector 3): the rewrite after
// a wait past the TTL, its keep-alive, and the TTL recommendation.
import { describe, expect, it } from "vitest";
import type { RunTotalsRecord } from "../cost-rollup";
import {
  CACHE_AGENT,
  CACHE_OPERATOR,
  cacheFrame,
  cacheInput,
  cacheRun,
  listPrices,
} from "./cache-fixture";
import { idleCacheRewrites, LIST_BREAKEVEN_READS } from "./cache-expiry";
import { detectFindings } from "./index";
import {
  Groups,
  type DetectContext,
  type DetectInput,
  type FindingDraft,
  type PricedRequestFrame,
} from "./shared";

const MIN = 60;

/**
 * A 5-minute walk: a 40k-token prefix written, then extended, then written
 * again after `gapSeconds`. The rewrite is 42,000 tokens at $3.45 over the
 * read, $0.1449.
 */
function fiveMinuteWalk(
  run: RunTotalsRecord,
  gapSeconds: number,
  over: Partial<PricedRequestFrame> = {},
): PricedRequestFrame[] {
  return [
    cacheFrame(run, 0, { input_uncached: 100, cache_write_5m: 40_000 }),
    cacheFrame(run, 60, {
      input_uncached: 100,
      cache_read: 40_000,
      cache_write_5m: 2_000,
    }),
    cacheFrame(
      run,
      60 + gapSeconds,
      { input_uncached: 100, cache_write_5m: 42_500 },
      over,
    ),
  ];
}

/** Two waits of 20 minutes on the 1-hour TTL that read the cache back, then one of 70 minutes that rewrote it. */
function oneHourWalk(
  run: RunTotalsRecord,
  bandWaits: number,
): PricedRequestFrame[] {
  const frames = [
    cacheFrame(run, 0, { input_uncached: 100, cache_write_1h: 40_000 }),
    cacheFrame(run, 60, {
      input_uncached: 100,
      cache_read: 40_000,
      cache_write_1h: 2_000,
    }),
  ];
  let at = 60;
  let cached = 42_000;
  for (let i = 0; i < bandWaits; i += 1) {
    at += 20 * MIN;
    frames.push(
      cacheFrame(run, at, {
        input_uncached: 100,
        cache_read: cached,
        cache_write_1h: 500,
      }),
    );
    cached += 500;
  }
  frames.push(
    cacheFrame(run, at + 70 * MIN, {
      input_uncached: 100,
      cache_write_1h: 43_500,
    }),
  );
  return frames;
}

function idle(drafts: FindingDraft[]): FindingDraft | undefined {
  return drafts.find((d) => d.kind === "idle_cache_rewrites");
}

function context(input: DetectInput): DetectContext {
  return {
    groups: new Groups(input.decidedSince),
    runs: new Map(input.runs.map((r) => [r.runId, r])),
    views: [],
    claimed: new Set(),
    taken: new Set(),
  };
}

describe("idle cache rewrites", () => {
  it("prices a rewrite after a 10-minute wait against two keep-alive reads", () => {
    const run = cacheRun();
    const finding = idle(
      detectFindings(cacheInput([{ run, frames: fiveMinuteWalk(run, 600) }])),
    );
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("agent");
    expect(finding!.subject).toBe(CACHE_AGENT);
    expect(finding!.evidence).toMatchObject({
      calls: 1,
      coveredCalls: 1,
      measuredTokens: 42_000,
      counterfactualTokens: 84_000,
      measuredMicros: "144900",
      counterfactualMicros: "25200",
    });
    expect(finding!.savingMicros).toBe(119_700n);
    expect(finding!.citedRuns).toEqual([run.runId]);
    expect(finding!.evidence.frames).toBeUndefined();
    expect(finding!.why).toBe(
      `${CACHE_AGENT} waited 10 minutes 1 time, and each wait rewrote a 42,000-token cache on average. A keep-alive would have cost $0.03 against $0.14 in rewrites.`,
    );
  });

  it("recommends the 1-hour TTL when it avoids more than it costs", () => {
    const run = cacheRun();
    const finding = idle(
      detectFindings(cacheInput([{ run, frames: fiveMinuteWalk(run, 600) }])),
    );
    expect(finding!.recommendation).toEqual({
      setting: "cache_ttl",
      value: "1h",
      current: "5m",
    });
    expect(finding!.evidence.recommendation).toEqual(finding!.recommendation);
    expect(finding!.fix).toBe(
      `Set the cache TTL for ${CACHE_AGENT} to 1 hour. Across 1 wait of 5 to 60 minutes, the 1-hour TTL would have cost $0.10 more on writes and would have avoided $0.14 in rewrites.`,
    );
  });

  it("recommends keeping 5 minutes when the 1-hour TTL costs more on writes", () => {
    const run = cacheRun();
    const frames = [
      ...fiveMinuteWalk(run, 600),
      cacheFrame(run, 690, {
        input_uncached: 100,
        cache_read: 42_500,
        cache_write_5m: 100_000,
      }),
    ];
    const finding = idle(detectFindings(cacheInput([{ run, frames }])));
    expect(finding!.recommendation).toEqual({
      setting: "cache_ttl",
      value: "5m",
      current: "5m",
    });
    expect(finding!.fix).toBe(
      `Keep the 5-minute cache TTL for ${CACHE_AGENT}, and send a keep-alive read every 4.5 minutes while it waits. Across 1 wait of 5 to 60 minutes, the 1-hour TTL would have cost $0.32 more on writes and would have avoided $0.14 in rewrites.`,
    );
  });

  it("keeps the 1-hour TTL when its reads within the hour avoided more rewrites than it cost", () => {
    const run = cacheRun();
    const finding = idle(
      detectFindings(cacheInput([{ run, frames: oneHourWalk(run, 2) }])),
    );
    // 43,000 tokens at $5.70 over the read, against one read at 54 minutes.
    expect(finding!.evidence).toMatchObject({
      measuredTokens: 43_000,
      counterfactualTokens: 43_000,
      measuredMicros: "245100",
      counterfactualMicros: "12900",
    });
    expect(finding!.recommendation).toEqual({
      setting: "cache_ttl",
      value: "1h",
      current: "1h",
    });
    expect(finding!.fix).toBe(
      `Keep the 1-hour cache TTL for ${CACHE_AGENT}. Across 2 waits of 5 to 60 minutes, the 1-hour TTL cost $0.19 more on writes and avoided $0.29 in rewrites. For waits past an hour, send a keep-alive read every 54 minutes while it waits.`,
    );
  });

  it("recommends lowering to 5 minutes when one wait within the hour does not pay for the 1-hour writes", () => {
    const run = cacheRun();
    const finding = idle(
      detectFindings(cacheInput([{ run, frames: oneHourWalk(run, 1) }])),
    );
    expect(finding!.recommendation).toEqual({
      setting: "cache_ttl",
      value: "5m",
      current: "1h",
    });
    expect(finding!.fix).toMatch(
      new RegExp(`^Set the cache TTL for ${CACHE_AGENT} to 5 minutes`),
    );
  });

  it("names no current TTL when the agent wrote both", () => {
    const run = cacheRun();
    const frames = fiveMinuteWalk(run, 600);
    frames[0] = cacheFrame(run, 0, {
      input_uncached: 100,
      cache_write_1h: 40_000,
    });
    const finding = idle(detectFindings(cacheInput([{ run, frames }])));
    expect(finding!.recommendation).toMatchObject({ setting: "cache_ttl" });
    expect(finding!.recommendation!.current).toBeUndefined();
  });

  it("weighs a rewrite that wrote both classes at the 5-minute write price on both sides", () => {
    const run = cacheRun();
    const frames = fiveMinuteWalk(run, 600);
    // The same 42,500 tokens as the 5-minute walk, split across both classes.
    frames[2] = cacheFrame(run, 660, {
      input_uncached: 100,
      cache_write_5m: 2_500,
      cache_write_1h: 40_000,
    });
    const finding = idle(detectFindings(cacheInput([{ run, frames }])));
    expect(finding!.recommendation).toEqual({
      setting: "cache_ttl",
      value: "1h",
    });
    // The 5-minute walk's own comparison: 42,000 rewritten tokens avoided at
    // $3.45 over the read, and $2.25 more on the other 42,500 tokens written.
    expect(finding!.fix).toBe(
      `Set the cache TTL for ${CACHE_AGENT} to 1 hour. Across 1 wait of 5 to 60 minutes, the 1-hour TTL would have cost $0.10 more on writes and would have avoided $0.14 in rewrites.`,
    );
  });

  it("recommends nothing when a request has no price for a write class", () => {
    const run = cacheRun();
    const frames = fiveMinuteWalk(run, 600);
    frames[0] = {
      ...frames[0]!,
      classPrices: { ...listPrices(), cache_write_1h: null },
    };
    const finding = idle(detectFindings(cacheInput([{ run, frames }])));
    expect(finding).toBeDefined();
    expect(finding!.recommendation).toBeUndefined();
    expect(finding!.fix).toBe(
      `For ${CACHE_AGENT}, send a keep-alive read every 4.5 minutes while it waits, or raise its cache TTL to 1 hour.`,
    );
  });

  it("reads a wait of exactly the TTL as a bust", () => {
    const run = cacheRun();
    const drafts = detectFindings(
      cacheInput([{ run, frames: fiveMinuteWalk(run, 300) }]),
    );
    expect(idle(drafts)).toBeUndefined();
    expect(drafts.find((d) => d.kind === "cache_busts")).toBeDefined();
  });

  it("leaves out a wait so long that the keep-alive costs more than the rewrite", () => {
    const run = cacheRun();
    // 12 reads at 4.5 minutes cost $0.1512, over the $0.1449 rewrite.
    const drafts = detectFindings(
      cacheInput([{ run, frames: fiveMinuteWalk(run, 55 * MIN) }]),
    );
    expect(drafts).toEqual([]);
  });

  it("cites an unpriced rewrite uncovered while a keep-alive pays at list prices", () => {
    const run = cacheRun();
    const unpriced = fiveMinuteWalk(run, 600).map((f) => ({
      ...f,
      classPrices: listPrices("EUR"),
    }));
    const input = cacheInput([{ run, frames: unpriced }]);
    const ctx = context(input);
    idleCacheRewrites.detect(input, ctx);
    const [group] = [...ctx.groups.values()];
    expect(group).toMatchObject({ calls: 1, covered: 0 });
    expect(group!.recommendation).toBeUndefined();
    expect(detectFindings(input)).toEqual([]);
  });

  it("leaves out an unpriced rewrite past the list break-even", () => {
    const run = cacheRun();
    const reads = LIST_BREAKEVEN_READS["5m"] + 1;
    const frames = fiveMinuteWalk(run, reads * 270, {
      classPrices: undefined,
    });
    const input = cacheInput([{ run, frames }]);
    const ctx = context(input);
    idleCacheRewrites.detect(input, ctx);
    expect([...ctx.groups.values()]).toEqual([]);
  });

  it("claims no frame", () => {
    const run = cacheRun();
    const input = cacheInput([{ run, frames: fiveMinuteWalk(run, 600) }]);
    const ctx = context(input);
    idleCacheRewrites.detect(input, ctx);
    expect(ctx.claimed.size).toBe(0);
    expect(idleCacheRewrites.counting).toBeNull();
    for (const draft of detectFindings(input))
      expect(draft.claims).toBeUndefined();
  });

  it("leaves out a rewrite after a compaction on the same chain", () => {
    const run = cacheRun();
    const frames = fiveMinuteWalk(run, 600);
    const at = new Date(frames[1]!.at.getTime() + 30_000);
    const input = cacheInput([{ run, frames }], {
      compactions: new Map([
        [
          run.runId,
          [
            {
              at,
              atMicros: at.getTime() * 1000,
              seq: 9,
              sessionUuid: null,
              trigger: "auto",
              tokensBefore: 42_000,
              tokensAfter: 8_000,
            },
          ],
        ],
      ]),
    });
    expect(detectFindings(input)).toEqual([]);
  });

  it("cites nothing for a run whose frames the pass did not read", () => {
    const run = cacheRun();
    const input = cacheInput([], {
      runs: [run],
      frameCoverage: { runs: 1, read: 0, capped: 1, unmatched: 0 },
    });
    expect(detectFindings(input)).toEqual([]);
  });

  it("walks each model and each chain apart", () => {
    const run = cacheRun();
    const frames = fiveMinuteWalk(run, 600);
    const other = [
      { ...frames[2]!, model: "claude-haiku-4-5" },
      { ...frames[2]!, sessionUuid: "00000000-0000-4000-8000-0000000000bb" },
    ];
    const input = cacheInput([
      { run, frames: [frames[0]!, frames[1]!, ...other] },
    ]);
    expect(detectFindings(input)).toEqual([]);
  });

  it("skips a frame with no class tokens", () => {
    const run = cacheRun();
    const frames = fiveMinuteWalk(run, 600, { classTokens: undefined });
    expect(detectFindings(cacheInput([{ run, frames }]))).toEqual([]);
  });

  it("gives the range of waits across the cited rewrites", () => {
    const a = cacheRun();
    const b = cacheRun();
    const finding = idle(
      detectFindings(
        cacheInput([
          { run: a, frames: fiveMinuteWalk(a, 600) },
          { run: b, frames: fiveMinuteWalk(b, 20 * MIN) },
        ]),
      ),
    );
    expect(finding!.evidence.calls).toBe(2);
    expect(finding!.why).toMatch(/waited 10 to 20 minutes 2 times/);
  });

  it("groups by operator when the run names no agent, and skips a run that names neither", () => {
    const byOperator = cacheRun({ agentKey: null });
    const anonymous = cacheRun({ agentKey: null, operatorKey: null });
    const drafts = detectFindings(
      cacheInput([
        { run: byOperator, frames: fiveMinuteWalk(byOperator, 600) },
        { run: anonymous, frames: fiveMinuteWalk(anonymous, 600) },
      ]),
    );
    expect(idle(drafts)).toMatchObject({
      level: "operator",
      subject: CACHE_OPERATOR,
      citedRuns: [byOperator.runId],
    });
  });

  it("skips a run that started before the finding was decided", () => {
    const run = cacheRun();
    const input = cacheInput([{ run, frames: fiveMinuteWalk(run, 600) }], {
      decidedSince: new Map([
        [
          `idle_cache_rewrites|agent|${CACHE_AGENT}`,
          new Date(run.startedAt.getTime() + 1),
        ],
      ]),
    });
    expect(idle(detectFindings(input))).toBeUndefined();
  });

  it("prices a keep-alive per 4.5 minutes on the 5-minute TTL", () => {
    const run = cacheRun();
    // 9 minutes is two reads, and 8.9 minutes is one.
    const finding = (seconds: number) =>
      idle(
        detectFindings(
          cacheInput([{ run, frames: fiveMinuteWalk(run, seconds) }]),
        ),
      );
    expect(finding(540)!.evidence.counterfactualTokens).toBe(84_000);
    expect(finding(534)!.evidence.counterfactualTokens).toBe(42_000);
  });
});
