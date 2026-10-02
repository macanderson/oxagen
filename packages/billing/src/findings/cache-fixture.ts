/**
 * cache-fixture.ts — the runs and model-call frames the cache detector tests
 * (detector 3) walk. Prices are Sonnet's list prices in USD: input $3, cache
 * read $0.30, a 5-minute write $3.75, and a 1-hour write $6 per million
 * tokens.
 */
import {
  ZERO_TOKENS,
  type RunTotalsRecord,
  type TokenCounts,
} from "../cost-rollup";
import {
  detectInputFixture,
  FIXTURE_WINDOW_START,
} from "./detect-input-fixture";
import type {
  DetectReads,
  FrameClassPrice,
  FrameClassPrices,
  FrameContextPart,
  PricedRequestFrame,
} from "./shared";

export const CACHE_AGENT = "acme.core.triage";
export const CACHE_OPERATOR = "prn_0123456789abcdefghjkmn";
const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const MODEL = "claude-sonnet-5";

/** Micros per million tokens, by class. */
export const RATES: Readonly<Record<keyof TokenCounts, bigint>> = {
  input_uncached: 3_000_000n,
  cache_read: 300_000n,
  cache_write_5m: 3_750_000n,
  cache_write_1h: 6_000_000n,
  output: 15_000_000n,
  reasoning: 15_000_000n,
  server_tool_request: 0n,
};

function entry(cls: keyof TokenCounts, currency: string): FrameClassPrice {
  return {
    entryId: `test:${MODEL}:${cls}`,
    microsPerMillion: RATES[cls],
    currency,
    source: "list",
  };
}

/** Every class priced at `RATES`, in `currency`. */
export function listPrices(currency = "USD"): FrameClassPrices {
  return {
    input_uncached: entry("input_uncached", currency),
    cache_read: entry("cache_read", currency),
    cache_write_5m: entry("cache_write_5m", currency),
    cache_write_1h: entry("cache_write_1h", currency),
    output: entry("output", currency),
    reasoning: entry("reasoning", currency),
    server_tool_request: null,
  };
}

let seq = 0;

/** A priced run that started 10 days into the fixture window. */
export function cacheRun(over: Partial<RunTotalsRecord> = {}): RunTotalsRecord {
  seq += 1;
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: ORG,
    workspaceId: WS,
    operatorPrincipalId: null,
    operatorKey: CACHE_OPERATOR,
    agentPrincipalId: null,
    agentKey: CACHE_AGENT,
    taskRef: null,
    costCenter: null,
    startedAt: new Date(FIXTURE_WINDOW_START.getTime() + 10 * 86_400_000),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 2,
    modelCalls: 1,
    toolCalls: 0,
    tokens: ZERO_TOKENS,
    costMicros: 0n,
    currency: "USD",
    costBasis: "gateway_observed",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models: [], tools: [], steps: null },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
    ...over,
  };
}

/** The system context digest every fixture frame records unless the override sets another. */
export const FIXTURE_DIGEST = "sys_fixture";

/**
 * One model call of `run`, `seconds` after the run started, carrying the
 * tokens given, priced at `RATES` unless the override sets other prices.
 * Every frame records `FIXTURE_DIGEST`, so a rewrite past the TTL is idle
 * unless the override changes or clears the digest.
 */
export function cacheFrame(
  run: RunTotalsRecord,
  seconds: number,
  counts: Partial<TokenCounts>,
  over: Partial<PricedRequestFrame> = {},
): PricedRequestFrame {
  const at = new Date(run.startedAt.getTime() + seconds * 1000);
  const classTokens: TokenCounts = { ...ZERO_TOKENS, ...counts };
  let cost = 0n;
  let tokens = 0;
  for (const cls of Object.keys(classTokens) as (keyof TokenCounts)[]) {
    cost += (BigInt(classTokens[cls]) * RATES[cls]) / 1_000_000n;
    tokens += classTokens[cls];
  }
  return {
    key: `${at.toISOString()}#0`,
    at,
    atMicros: at.getTime() * 1000,
    costMicros: cost,
    tokens,
    basis: "gateway_observed",
    sessionUuid: null,
    model: MODEL,
    provider: "anthropic",
    classTokens,
    classPrices: listPrices(),
    systemContextDigest: FIXTURE_DIGEST,
    systemContextParts: null,
    ...over,
  };
}

/** A part of a system context. */
export function part(
  kind: FrameContextPart["kind"],
  name: string,
  digest: string,
): FrameContextPart {
  return { kind, name, digest, tokens: 1_000 };
}

/** A detector input over the runs given, with each run's frames read. */
export function cacheInput(
  runs: readonly { run: RunTotalsRecord; frames: PricedRequestFrame[] }[],
  over: Partial<DetectReads> = {},
): DetectReads {
  return detectInputFixture({
    runs: runs.map((r) => r.run),
    frames: new Map(runs.map((r) => [r.run.runId, r.frames])),
    ...over,
  });
}
