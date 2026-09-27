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
import { detectFindings } from "./index";
import {
  inCodeListBook,
  lighterModel,
  modelClassFit,
  modelClassFitWith,
} from "./model-class-fit";
import { buildRunViews } from "./requests";
import { SPIN_LOOP_REPEATS } from "./spin-loops";
import {
  findingFingerprint,
  Groups,
  toDraft,
  type DetectInput,
  type FindingDraft,
  type ToolCallObservation,
} from "./shared";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date("2026-09-15T00:00:00.000Z");
const OPERATOR = "prn_0123456789abcdefghjkmn";
const AGENT = "acme.core.triage";
const OPUS = "claude-opus-5-5";

/** A price row, in USD per million units. */
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

/**
 * The book the exact tests reprice against. It prices input and output only,
 * so a run that read the cache has a class the smaller model has no price for.
 */
const BOOK: PriceBook = [
  price("claude-sonnet-5", "anthropic", "input_uncached", 2),
  price("claude-sonnet-5", "anthropic", "output", 10),
  price("claude-haiku-4-5", "anthropic", "input_uncached", 1),
  price("claude-haiku-4-5", "anthropic", "output", 5),
  price("gpt-5-nano", "openai", "input_uncached", 0.05),
  price("gpt-5-nano", "openai", "output", 0.4),
];

const detector = modelClassFitWith(() => BOOK);

function tokens(over: Partial<TokenCounts>): TokenCounts {
  return { ...ZERO_TOKENS, ...over };
}

/** A model's share of a run, priced at the rates given in USD per million. */
function model(
  id: string,
  counts: Partial<TokenCounts>,
  rates: { input: number; output: number },
  over: Partial<ModelBreakdown> = {},
): ModelBreakdown {
  const t = tokens(counts);
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
    ...over,
  };
}

/** Opus at $4 and $20: 1M input and 100k output cost $6, and $3 on Sonnet 5. */
const opus = (over: Partial<ModelBreakdown> = {}) =>
  model(
    OPUS,
    { input_uncached: 1_000_000, output: 100_000 },
    { input: 4, output: 20 },
    over,
  );

/** Haiku at $1 and $5: 200k input and 20k output cost $0.30. */
const haiku = () =>
  model(
    "claude-haiku-4-5",
    { input_uncached: 200_000, output: 20_000 },
    { input: 1, output: 5 },
  );

let seq = 0;

/** A sealed run that started inside the window, priced from its models. */
function run(
  models: ModelBreakdown[] = [opus()],
  over: Partial<RunTotalsRecord> = {},
): RunTotalsRecord {
  seq += 1;
  const startedAt = new Date(START.getTime() + seq * 60_000);
  const sum = models.reduce<TokenCounts>(
    (acc, m) => {
      const out = { ...acc };
      for (const k of Object.keys(out) as (keyof TokenCounts)[])
        out[k] += m.tokens[k];
      return out;
    },
    { ...ZERO_TOKENS },
  );
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: ORG,
    workspaceId: WS,
    operatorPrincipalId: null,
    operatorKey: OPERATOR,
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
    tokens: sum,
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
    ...over,
  };
}

/** A read-only call `at` seconds into the run. */
function call(
  r: RunTotalsRecord,
  at: number,
  over: Partial<ToolCallObservation> = {},
): ToolCallObservation {
  return {
    runId: r.runId,
    seq: at,
    tool: "Read",
    inputDigest: `in-${at}`,
    outputDigest: `out-${at}`,
    isMutating: false,
    resultTokens: 500,
    sessionUuid: null,
    ...over,
    at: new Date(r.startedAt.getTime() + at * 1_000),
  };
}

function input(
  runs: RunTotalsRecord[],
  toolCalls: ToolCallObservation[],
  over: Partial<DetectInput> = {},
): DetectInput {
  return {
    window: { start: START, end: END },
    toolWindowStart: START,
    runs,
    toolCalls,
    decidedSince: new Map(),
    ...over,
  };
}

/** Each run with one read-only call. */
function readOnly(runs: RunTotalsRecord[]): ToolCallObservation[] {
  return runs.map((r) => call(r, 1));
}

/** The drafts the detector alone writes against the test book. */
function detect(i: DetectInput, d = detector): FindingDraft[] {
  const runs = new Map(i.runs.map((r) => [r.runId, r]));
  const groups = new Groups(i.decidedSince);
  d.detect(i, {
    groups,
    runs,
    views: buildRunViews(i, runs),
    claimed: new Set(),
    taken: new Set(),
  });
  return [...groups.values()]
    .map((g) => toDraft(g, i.window.end, d.prose))
    .filter((f): f is FindingDraft => f !== null);
}

describe("model class fit", () => {
  it("reprices a read-only run at the next smaller class and labels it estimated", () => {
    const r = run();
    const [f, ...rest] = detect(input([r], readOnly([r])));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      kind: "model_class_fit",
      level: "agent",
      subject: AGENT,
      basis: "estimated",
      confidence: "high",
      savingMicros: 3_000_000n,
      citedRuns: [r.runId],
    });
    expect(f!.evidence).toMatchObject({
      calls: 1,
      coveredCalls: 1,
      measuredMicros: "6000000",
      counterfactualMicros: "3000000",
      measuredTokens: 1_100_000,
      counterfactualTokens: 1_100_000,
    });
    expect(f!.why).toBe(
      "1 run changed no file. Repriced from claude-opus-5-5 to claude-sonnet-5 at list prices, it would have cost an estimated 50% less.",
    );
    expect(f!.fix).toContain("claude-sonnet-5");
    expect(f!.fix).toContain("model-route steering record");
    expect(f!.fix).toContain("Replay");
  });

  it("claims no frame and pins no call", () => {
    const r = run();
    const [f] = detect(input([r], readOnly([r])));
    expect(f!.claims).toBeUndefined();
    expect(f!.evidence.frames).toBeUndefined();
    expect(detector.counting).toBeNull();
  });

  it("adds every read-only run of one agent into one finding", () => {
    const a = run();
    const b = run();
    const [f] = detect(input([a, b], readOnly([a, b])));
    expect(f!.savingMicros).toBe(6_000_000n);
    expect(f!.citedRuns).toHaveLength(2);
    expect(f!.why).toMatch(
      /^2 runs changed no file\. .*, they would have cost an estimated 50% less\.$/,
    );
  });

  it("leaves out a run with a call that changed something", () => {
    const r = run();
    const calls = [call(r, 1), call(r, 2, { tool: "Edit", isMutating: true })];
    expect(detect(input([r], calls))).toEqual([]);
  });

  it("leaves out a run with a call the classifier said nothing about", () => {
    const r = run();
    expect(detect(input([r], [call(r, 1, { isMutating: null })]))).toEqual([]);
  });

  it("leaves out a run that has not ended", () => {
    const r = run([opus()], { sealedAt: null });
    expect(detect(input([r], readOnly([r])))).toEqual([]);
  });

  it("leaves out a run that started before the tool-call read began", () => {
    const r = run();
    const late = new Date(r.startedAt.getTime() + 1);
    expect(detect(input([r], readOnly([r]), { toolWindowStart: late }))).toEqual(
      [],
    );
  });

  it("leaves out a run with no tool call", () => {
    expect(detect(input([run()], []))).toEqual([]);
  });

  it("leaves out a run with a spin loop, so detector 1 keeps its spend", () => {
    const r = run();
    const calls = Array.from({ length: SPIN_LOOP_REPEATS + 1 }, (_, i) =>
      call(r, i + 1, { inputDigest: "in-same", outputDigest: "out-same" }),
    );
    expect(detect(input([r], calls))).toEqual([]);
  });

  it("leaves out a run on the smallest class", () => {
    const r = run([haiku()]);
    expect(detect(input([r], readOnly([r])))).toEqual([]);
  });

  it("leaves out a run that names neither agent nor operator", () => {
    const r = run([opus()], { agentKey: null, operatorKey: null });
    expect(detect(input([r], readOnly([r])))).toEqual([]);
  });

  it("cites the operator when the run names no agent", () => {
    const r = run([opus()], { agentKey: null });
    const [f] = detect(input([r], readOnly([r])));
    expect(f).toMatchObject({ level: "operator", subject: OPERATOR });
  });

  it("keeps a model on the smallest class at its measured cost", () => {
    const r = run([opus(), haiku()]);
    const [f] = detect(input([r], readOnly([r])));
    expect(f!.evidence.measuredMicros).toBe("6300000");
    expect(f!.evidence.counterfactualMicros).toBe("3300000");
    expect(f!.savingMicros).toBe(3_000_000n);
    expect(f!.why).toContain("from claude-opus-5-5 to claude-sonnet-5 at");
    expect(f!.why).not.toContain("claude-haiku-4-5 to");
  });

  it("moves Sonnet to Haiku and OpenAI mini to nano", () => {
    const sonnet = model(
      "anthropic/claude-sonnet-5",
      { input_uncached: 1_000_000, output: 100_000 },
      { input: 2, output: 10 },
    );
    const mini = model(
      "gpt-5-mini",
      { input_uncached: 1_000_000, output: 100_000 },
      { input: 0.25, output: 2 },
      { provider: "openai" },
    );
    expect(lighterModel(sonnet)).toBe("claude-haiku-4-5");
    expect(lighterModel(mini)).toBe("gpt-5-nano");
    const r = run([sonnet, mini]);
    const [f] = detect(input([r], readOnly([r])));
    // Sonnet: $3 measured, $1.50 on Haiku. Mini: $0.45, $0.09 on nano.
    expect(f!.evidence.measuredMicros).toBe("3450000");
    expect(f!.evidence.counterfactualMicros).toBe("1590000");
    expect(f!.why).toContain(
      "from anthropic/claude-sonnet-5 to claude-haiku-4-5 and gpt-5-mini to gpt-5-nano at list prices",
    );
  });

  it("names two moves and counts the rest", () => {
    const moves = [
      opus(),
      model(
        "claude-sonnet-5",
        { input_uncached: 1_000_000 },
        { input: 2, output: 10 },
      ),
      model(
        "gpt-5-mini",
        { input_uncached: 1_000_000 },
        { input: 0.25, output: 2 },
      ),
    ];
    const r = run(moves);
    const [f] = detect(input([r], readOnly([r])));
    expect(f!.why).toContain(
      "from claude-opus-5-5 to claude-sonnet-5, claude-sonnet-5 to claude-haiku-4-5, and 1 more model at",
    );
  });

  it("has no smaller class for a class its vendor has no model for, or off every ladder", () => {
    const rates = { input: 2, output: 12 };
    const counts = { input_uncached: 1_000 };
    expect(lighterModel(model("gpt-5-pro", counts, rates))).toBeNull();
    expect(
      lighterModel(model("gemini-3-pro", counts, rates, { provider: "google" })),
    ).toBeNull();
    expect(lighterModel(model("claude-fable-1", counts, rates))).toBeNull();
    expect(lighterModel(model("gpt-5", counts, rates))).toBeNull();
    expect(lighterModel(model("internal/pro", counts, rates))).toBeNull();
  });

  it("cites but does not cover a run whose measured cost is an estimate", () => {
    const r = run([opus()], { costBasis: "estimated" });
    expect(detect(input([r], readOnly([r])))).toEqual([]);
  });

  it("cites but does not cover a run with an unpriced call", () => {
    const r = run([opus({ hasUnpriced: true })]);
    expect(detect(input([r], readOnly([r])))).toEqual([]);
  });

  it("cites but does not cover a run the smaller model has no price for", () => {
    const cached = model(
      OPUS,
      { input_uncached: 1_000_000, cache_read: 1_000_000, output: 100_000 },
      { input: 4, output: 20 },
    );
    const covered = run();
    const r = run([cached]);
    const [f] = detect(input([covered, r], readOnly([covered, r])));
    expect(f!.evidence.calls).toBe(2);
    expect(f!.evidence.coveredCalls).toBe(1);
    expect(f!.confidence).toBe("medium");
    expect(f!.savingMicros).toBe(3_000_000n);
  });

  it("writes nothing when the saving is under a cent", () => {
    const tiny = model(
      OPUS,
      { input_uncached: 1_000, output: 100 },
      { input: 4, output: 20 },
    );
    const r = run([tiny]);
    expect(detect(input([r], readOnly([r])))).toEqual([]);
  });

  it("cites only runs that started after the finding was last decided", () => {
    const before = run();
    const after = run();
    const decided = new Map([
      [
        findingFingerprint("model_class_fit", "agent", AGENT),
        new Date(before.startedAt.getTime() + 1),
      ],
    ]);
    const [f] = detect(
      input([before, after], readOnly([before, after]), {
        decidedSince: decided,
      }),
    );
    expect(f!.citedRuns).toEqual([after.runId]);
  });

  it("names the prices it used", () => {
    const own = modelClassFitWith(() => BOOK, "your negotiated prices");
    const r = run();
    const [f] = detect(input([r], readOnly([r])), own);
    expect(f!.why).toContain("at your negotiated prices,");
  });
});

describe("the registered detector", () => {
  it("reads the in-code list book, which prices each smaller model", () => {
    const book = inCodeListBook();
    expect(inCodeListBook()).toBe(book);
    for (const target of ["claude-sonnet-5", "claude-haiku-4-5", "gpt-5-nano"])
      for (const tokenClass of ["input_uncached", "output"])
        expect(
          book.some(
            (e) =>
              e.model === target &&
              e.tokenClass === tokenClass &&
              e.orgId === null,
          ),
        ).toBe(true);
    expect(new Set(book.map((e) => e.id)).size).toBe(book.length);
  });

  it("runs in the pass and writes an estimated finding", () => {
    const r = run();
    const findings = detectFindings(input([r], readOnly([r])));
    const f = findings.find((d) => d.kind === "model_class_fit");
    expect(f).toMatchObject({
      level: "agent",
      subject: AGENT,
      basis: "estimated",
    });
    expect(f!.savingMicros).toBeGreaterThan(0n);
    expect(f!.why).toContain("to claude-sonnet-5 at list prices");
    expect(f!.claims).toBeUndefined();
    expect(modelClassFit.kinds).toEqual(["model_class_fit"]);
  });
});
