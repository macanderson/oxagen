import { describe, expect, it } from "vitest";
import {
  ZERO_TOKENS,
  type ModelBreakdown,
  type RunTotalsRecord,
  type TokenCounts,
} from "../cost-rollup";
import {
  PRICE_UNIT_BY_TOKEN_CLASS,
  type PriceBook,
  type PriceEntry,
  type PriceTokenClass,
} from "../price-book";
import {
  planReplay,
  REPLAY_SAMPLE_MAX,
  replayPlanDigest,
  startReplay,
  type ReplayApproval,
  type ReplayOwnership,
  type ReplayPlan,
  type ReplayRun,
} from "./model-class-replay";
import { findingFingerprint } from "./shared";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const NOW = new Date("2026-09-15T00:00:00.000Z");
const AGENT = "acme.core.triage";
const OWNER = "prn_0123456789abcdefghjkmn";
const OTHER = "prn_zzzzzzzzzzzzzzzzzzzzzz";
const OPUS = "claude-opus-5-5";

function price(
  model: string,
  provider: string,
  tokenClass: PriceTokenClass,
  usdPerMillion: number,
): PriceEntry {
  return {
    id: `test:${model}:${tokenClass}`,
    orgId: null,
    provider,
    model,
    modelAliases: [],
    region: null,
    tokenClass,
    unit: PRICE_UNIT_BY_TOKEN_CLASS[tokenClass],
    currency: "USD",
    microsPerMillion: BigInt(Math.round(usdPerMillion * 1_000_000)),
    effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
  };
}

/** Sonnet 5 at $2 and $10 per million, with no cache read price. */
const BOOK: PriceBook = [
  price("claude-sonnet-5", "anthropic", "input_uncached", 2),
  price("claude-sonnet-5", "anthropic", "output", 10),
];

/** A model's share of a run at the rates given, in USD per million. */
function model(
  id: string,
  counts: Partial<TokenCounts>,
  rates: { input: number; output: number },
): ModelBreakdown {
  const t = { ...ZERO_TOKENS, ...counts };
  const input = BigInt(Math.round(t.input_uncached * rates.input));
  const output = BigInt(Math.round(t.output * rates.output));
  return {
    model: id,
    provider: null,
    calls: 1,
    tokens: t,
    costMicros: input + output,
    costByClass: {
      input_uncached: input,
      cache_read: 0n,
      cache_write_5m: 0n,
      cache_write_1h: 0n,
      output,
      reasoning: 0n,
      server_tool_request: 0n,
    },
    cacheSavingMicros: 0n,
    basis: "gateway_observed",
    hasUnpriced: false,
  };
}

/** Opus at $4 and $20 over `millions` million input tokens: $4 per million on Opus, $2 on Sonnet 5. */
const opus = (millions = 1) =>
  model(OPUS, { input_uncached: millions * 1_000_000 }, { input: 4, output: 20 });

let seq = 0;

function run(
  models: ModelBreakdown[] = [opus()],
  operatorKey: string | null = OWNER,
): RunTotalsRecord {
  seq += 1;
  const startedAt = new Date(START.getTime() + seq * 60_000);
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: ORG,
    workspaceId: WS,
    operatorPrincipalId: null,
    operatorKey,
    agentPrincipalId: null,
    agentKey: AGENT,
    taskRef: null,
    costCenter: null,
    startedAt,
    sealedAt: new Date(startedAt.getTime() + 30_000),
    turns: 1,
    retries: 0,
    enforcementTier: "gateway",
    replayGrade: "view",
    steps: 2,
    modelCalls: models.length,
    toolCalls: 1,
    tokens: models.reduce<TokenCounts>(
      (acc, m) => {
        const out = { ...acc };
        for (const k of Object.keys(out) as (keyof TokenCounts)[])
          out[k] += m.tokens[k];
        return out;
      },
      { ...ZERO_TOKENS },
    ),
    costMicros: models.reduce((acc, m) => acc + (m.costMicros ?? 0n), 0n),
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models, tools: [], steps: null },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
  };
}

function finding(runs: RunTotalsRecord[]) {
  return {
    kind: "model_class_fit" as const,
    fingerprint: findingFingerprint("model_class_fit", "agent", AGENT),
    subject: AGENT,
    currency: "USD",
    citedRuns: runs.map((r) => r.runId),
  };
}

function plan(
  runs: RunTotalsRecord[],
  over: { sampleMax?: number; operatorKey?: string } = {},
) {
  return planReplay({
    finding: finding(runs),
    runs: new Map(runs.map((r) => [r.runId, r])),
    now: NOW,
    book: BOOK,
    ...over,
  });
}

function approve(p: ReplayPlan, over: Partial<ReplayApproval> = {}) {
  return {
    planDigest: p.digest,
    shownMicros: p.estimatedMicros,
    shownCurrency: p.currency,
    approvedBy: OWNER,
    approvedAtMs: NOW.getTime() + 60_000,
    ...over,
  };
}

/** Each operator owns their own runs. */
const owns: ReplayOwnership = (approver, operatorKey) =>
  approver === operatorKey;

describe("planReplay", () => {
  it("prices each run on the smaller class and sums the estimate", () => {
    const a = run([opus(1)]);
    const b = run([opus(2)]);
    const p = plan([a, b])!;
    expect(p).toMatchObject({
      kind: "model_class_fit",
      subject: AGENT,
      currency: "USD",
      estimatedMicros: 6_000_000n,
      plannedAtMs: NOW.getTime(),
    });
    expect(p.runs).toEqual([
      {
        runId: a.runId,
        operatorKey: OWNER,
        models: [{ from: OPUS, to: "claude-sonnet-5" }],
        measuredMicros: 4_000_000n,
        estimatedMicros: 2_000_000n,
      },
      {
        runId: b.runId,
        operatorKey: OWNER,
        models: [{ from: OPUS, to: "claude-sonnet-5" }],
        measuredMicros: 8_000_000n,
        estimatedMicros: 4_000_000n,
      },
    ]);
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("digests the same plan the same way, and a later plan differently", () => {
    const runs = [run(), run()];
    const first = plan(runs)!;
    expect(plan(runs)!.digest).toBe(first.digest);
    const { digest, ...fields } = first;
    expect(replayPlanDigest(fields)).toBe(digest);
    const later = planReplay({
      finding: finding(runs),
      runs: new Map(runs.map((r) => [r.runId, r])),
      now: new Date(NOW.getTime() + 1),
      book: BOOK,
    })!;
    expect(later.digest).not.toBe(first.digest);
  });

  it("samples across the runs from the smallest to the largest", () => {
    const runs = Array.from({ length: 10 }, (_, i) => run([opus(10 - i)]));
    const p = plan(runs)!;
    expect(REPLAY_SAMPLE_MAX).toBe(5);
    // Ranked by measured cost, the middle of five equal slices: 2, 4, 6, 8, and 10 million.
    expect(p.runs.map((r) => r.measuredMicros)).toEqual([
      8_000_000n,
      16_000_000n,
      24_000_000n,
      32_000_000n,
      40_000_000n,
    ]);
    expect(p.estimatedMicros).toBe(60_000_000n);
    expect(plan(runs, { sampleMax: 1 })!.runs.map((r) => r.measuredMicros)).toEqual(
      [24_000_000n],
    );
  });

  it("holds the sample to five and refuses a size that is not a whole number", () => {
    const runs = Array.from({ length: 10 }, (_, i) => run([opus(10 - i)]));
    expect(plan(runs, { sampleMax: 10 })!.runs).toHaveLength(REPLAY_SAMPLE_MAX);
    for (const sampleMax of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => plan(runs, { sampleMax })).toThrow(RangeError);
  });

  it("plans one operator's runs when asked", () => {
    const mine = run([opus(1)]);
    const theirs = run([opus(2)], OTHER);
    expect(plan([mine, theirs])!.runs.map((r) => r.runId)).toEqual([
      mine.runId,
      theirs.runId,
    ]);
    const p = plan([mine, theirs], { operatorKey: OTHER })!;
    expect(p.runs.map((r) => r.runId)).toEqual([theirs.runId]);
    expect(p.estimatedMicros).toBe(4_000_000n);
  });

  it("leaves out a run it cannot price, has no record of, cannot move, or no operator owns", () => {
    const priced = run();
    const unowned = run([opus()], null);
    const cached = run([
      model(
        OPUS,
        { input_uncached: 1_000_000, cache_read: 1_000_000 },
        { input: 4, output: 20 },
      ),
    ]);
    const haiku = run([
      model(
        "claude-haiku-4-5",
        { input_uncached: 1_000_000 },
        { input: 1, output: 5 },
      ),
    ]);
    const missing = run();
    const p = planReplay({
      finding: finding([priced, cached, haiku, missing, unowned]),
      runs: new Map([priced, cached, haiku, unowned].map((r) => [r.runId, r])),
      now: NOW,
      book: BOOK,
    })!;
    expect(p.runs.map((r) => r.runId)).toEqual([priced.runId]);
    expect(p.estimatedMicros).toBe(2_000_000n);
  });

  it("plans nothing for another kind, or when no run is left", () => {
    const r = run();
    expect(
      planReplay({
        finding: { ...finding([r]), kind: "spin_loops" },
        runs: new Map([[r.runId, r]]),
        now: NOW,
        book: BOOK,
      }),
    ).toBeNull();
    expect(plan([])).toBeNull();
  });

  it("reprices at list prices when the caller passes no book", () => {
    const r = run();
    const p = planReplay({
      finding: finding([r]),
      runs: new Map([[r.runId, r]]),
      now: NOW,
    })!;
    // Sonnet 5 lists input at $2 per million.
    expect(p.runs[0]!.models).toEqual([{ from: OPUS, to: "claude-sonnet-5" }]);
    expect(p.estimatedMicros).toBe(2_000_000n);
  });
});

describe("startReplay", () => {
  const p = plan([run(), run()])!;

  it("starts on an owner's approval that showed the estimated cost", () => {
    const approval = approve(p);
    const result = startReplay(p, approval, owns);
    expect(result).toEqual({ ok: true, start: { plan: p, approval } });
  });

  it("hands the dispatcher frozen copies the caller cannot change", () => {
    const mine = plan([run(), run()])!;
    const result = startReplay(mine, approve(mine), owns);
    if (!result.ok) throw new Error(result.refusal);
    const { start } = result;
    const runs = mine.runs as ReplayRun[];
    runs.push(runs[0]!);
    (runs[0]!.models[0]! as { to: string }).to = OPUS;
    expect(start.plan).not.toBe(mine);
    expect(start.plan.runs).toHaveLength(2);
    expect(start.plan.runs[0]!.models[0]!.to).toBe("claude-sonnet-5");
    for (const part of [
      start,
      start.plan,
      start.plan.runs,
      start.plan.runs[0],
      start.plan.runs[0]!.models,
      start.plan.runs[0]!.models[0],
      start.approval,
    ])
      expect(Object.isFrozen(part)).toBe(true);
  });

  it("refuses without an approval", () => {
    expect(startReplay(p, null, owns)).toEqual({
      ok: false,
      refusal: "no_approval",
    });
  });

  it("refuses a plan changed after it was digested", () => {
    const changed = { ...p, runs: p.runs.slice(1) };
    expect(startReplay(changed, approve(p), owns)).toEqual({
      ok: false,
      refusal: "plan_changed",
    });
  });

  it("refuses an approval of another plan", () => {
    const other = plan([run()])!;
    expect(startReplay(p, approve(other), owns)).toEqual({
      ok: false,
      refusal: "other_plan",
    });
  });

  it("refuses an approval that showed another cost", () => {
    const under = approve(p, { shownMicros: p.estimatedMicros - 1n });
    const euros = approve(p, { shownCurrency: "EUR" });
    for (const approval of [under, euros])
      expect(startReplay(p, approval, owns)).toEqual({
        ok: false,
        refusal: "cost_not_shown",
      });
  });

  it("refuses an approver who does not own the runs", () => {
    expect(startReplay(p, approve(p, { approvedBy: OTHER }), owns)).toEqual({
      ok: false,
      refusal: "not_an_owner",
    });
    expect(startReplay(p, approve(p), () => false)).toEqual({
      ok: false,
      refusal: "not_an_owner",
    });
  });

  it("refuses an approver who owns only some of the sampled runs", () => {
    const mixed = plan([run([opus(1)]), run([opus(2)], OTHER)])!;
    expect(startReplay(mixed, approve(mixed), owns)).toEqual({
      ok: false,
      refusal: "not_an_owner",
    });
    // A team that owns both operators' runs may approve the whole plan.
    const team: ReplayOwnership = (approver) => approver === OWNER;
    expect(startReplay(mixed, approve(mixed), team).ok).toBe(true);
  });

  it("refuses a plan with no runs", () => {
    const bare = {
      kind: p.kind,
      fingerprint: p.fingerprint,
      subject: p.subject,
      currency: p.currency,
      runs: [],
      estimatedMicros: 0n,
      plannedAtMs: p.plannedAtMs,
    };
    const empty = { ...bare, digest: replayPlanDigest(bare) };
    expect(startReplay(empty, approve(empty), () => true)).toEqual({
      ok: false,
      refusal: "not_an_owner",
    });
  });

  it("refuses an approval older than the plan or with no time", () => {
    for (const approvedAtMs of [NOW.getTime() - 1, Number.NaN])
      expect(startReplay(p, approve(p, { approvedAtMs }), owns)).toEqual({
        ok: false,
        refusal: "approved_before_plan",
      });
  });
});
