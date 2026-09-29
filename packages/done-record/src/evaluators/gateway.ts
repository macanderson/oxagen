// gateway.ts: merge what the gateway recorded for several stages into one.
//
// The tools check, the budget check, and the policy and budget oracles read
// the work as a whole: every build stage's tool calls and every build stage's
// spend. The merged record is only as strong as its weakest stage.
import {
  ENFORCEMENT_TIERS,
  type EnforcementTier,
  type GatewayRecords,
  type UsageBasis,
} from "./types";

function weakestTier(tiers: readonly EnforcementTier[]): EnforcementTier {
  let weakest = 0;
  for (const tier of tiers) {
    weakest = Math.max(weakest, ENFORCEMENT_TIERS.indexOf(tier));
  }
  return ENFORCEMENT_TIERS[weakest] as EnforcementTier;
}

function mergedBasis(bases: readonly UsageBasis[]): UsageBasis {
  const first = bases[0] as UsageBasis;
  return bases.every((basis) => basis === first) ? first : "mixed";
}

/**
 * Merge the gateway's records for several stages, in stage order. The tier is
 * the weakest stage's. The basis is `mixed` when the stages disagree. Tool
 * calls keep their order. Counters add up, and cost is null when any stage
 * reported none. Throws when there is no stage to merge.
 */
export function mergeGatewayRecords(stages: readonly GatewayRecords[]): GatewayRecords {
  if (stages.length === 0) {
    throw new TypeError("mergeGatewayRecords needs at least one stage's records");
  }
  let usd: number | null = 0;
  let tokens = 0;
  let toolCalls = 0;
  let minutes = 0;
  let retries = 0;
  let stopAttempts = 0;
  for (const { usage } of stages) {
    usd = usd === null || usage.usd === null ? null : usd + usage.usd;
    tokens += usage.tokens;
    toolCalls += usage.toolCalls;
    minutes += usage.minutes;
    retries += usage.retries;
    stopAttempts += usage.stopAttempts;
  }
  return {
    tier: weakestTier(stages.map((stage) => stage.tier)),
    basis: mergedBasis(stages.map((stage) => stage.basis)),
    toolCalls: stages.flatMap((stage) => stage.toolCalls),
    usage: { usd, tokens, toolCalls, minutes, retries, stopAttempts },
  };
}
