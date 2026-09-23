// Builders for the spend handler tests: run rows and daily rows in the shape
// the rollup store returns, with every money column null unless a test sets
// it, so a figure a test did not price cannot leak in as a zero.
import type { CapabilityContext } from "@oxagen/oxagen";
import type { DailyTotalsRecord, RunTotalsRecord } from "@oxagen/billing";
import { ZERO_TOKENS } from "@oxagen/billing";

export const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

export function ctx(): CapabilityContext {
  return {
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    userId: "0192d4a8-7c1e-7a00-8000-0000000005e1",
    apiKeyId: null,
    requestId: "req_1",
    surface: "api",
    messageId: null,
  };
}

/** The operator's principal public id: the key of its operator group. */
export const OPERATOR = "prn_0123456789abcdefghjkmn";

let seq = 0;

export function run(over: Partial<RunTotalsRecord> = {}): RunTotalsRecord {
  seq += 1;
  return {
    runId: `tse_${String(seq).padStart(22, "0")}`,
    runSource: "tacho",
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    operatorPrincipalId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
    operatorKey: OPERATOR,
    agentPrincipalId: null,
    agentKey: "acme.core.cc",
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-09-10T12:00:00.000Z"),
    sealedAt: new Date("2026-09-10T12:30:00.000Z"),
    turns: 3,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 4,
    modelCalls: 2,
    toolCalls: 2,
    tokens: { ...ZERO_TOKENS },
    costMicros: null,
    currency: "USD",
    costBasis: null,
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models: [], tools: [] },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    ...over,
  };
}

/** A priced run: one model, its cost split so the waste reader can see cache writes. */
export function pricedRun(
  micros: bigint,
  over: Partial<RunTotalsRecord> & {
    cacheWriteMicros?: bigint;
  } = {},
): RunTotalsRecord {
  const { cacheWriteMicros = 0n, ...rest } = over;
  const basis = rest.costBasis ?? "client_attested";
  return run({
    costMicros: micros,
    costBasis: basis,
    tokens: {
      ...ZERO_TOKENS,
      input_uncached: 1000,
      output: 200,
      ...(rest.tokens ?? {}),
    },
    breakdown: {
      models: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 2,
          tokens: { ...ZERO_TOKENS, input_uncached: 1000, output: 200 },
          costMicros: micros,
          costByClass: {
            input_uncached: micros - cacheWriteMicros,
            cache_read: 0n,
            cache_write_5m: cacheWriteMicros,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
          },
          basis,
          hasUnpriced: false,
        },
      ],
      tools: [{ name: "Read", calls: 2 }],
    },
    ...rest,
  });
}

export function daily(
  over: Partial<DailyTotalsRecord> = {},
): DailyTotalsRecord {
  return {
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    day: "2026-09-10",
    groupKind: "operator",
    groupKey: OPERATOR,
    provider: null,
    runs: 1,
    calls: 4,
    costMicros: null,
    currency: "USD",
    costBasis: null,
    provenMicros: null,
    acceptedMicros: null,
    productiveRatio: null,
    tokens: { ...ZERO_TOKENS },
    ...over,
  };
}
