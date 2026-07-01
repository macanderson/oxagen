/**
 * Routing config accessors (deliverable 4).
 *
 * Precedence for every key: explicit env override → baked-in defaults in
 * `routing-policy.json`. The worker model ids are NOT re-declared here — they
 * live in `runtime/models.json -> registry.workerModels` (Group 1's single
 * source of truth) and are read through {@link roles}, so there is exactly one
 * place that says "the default code worker is Sonnet 5".
 *
 * These four keys are the routing slice of the merged pipeline config (Group 6):
 * `routing.trivialMaxComplexity`, `routing.switchCostTokenBudget`,
 * `routing.defaultCodeWorker`, `routing.cheapBasicWorker`.
 */
import { roles } from "../runtime/registry.js";
import policyJson from "./routing-policy.json" with { type: "json" };
import type { Complexity } from "./types.js";

interface RoutingPolicyFile {
  config: { routing: { trivialMaxComplexity: Complexity; switchCostTokenBudget: number } };
  complexityScale: Complexity[];
  switchCostModel: {
    expectedContextTokens: number;
    valueTokenScale: number;
    defaultTaskValue: number;
  };
}

const POLICY = policyJson as unknown as RoutingPolicyFile;

/** The ordered complexity scale, worst → best. Used for `<=` comparisons. */
export const COMPLEXITY_SCALE: readonly Complexity[] = POLICY.complexityScale;

/** Numeric rank of a complexity on the scale (trivial = 0). */
export function complexityRank(c: Complexity): number {
  const i = COMPLEXITY_SCALE.indexOf(c);
  // A value off the known scale is treated as maximally complex, never trivial,
  // so an unknown label can never accidentally stay on the coordinator.
  return i === -1 ? COMPLEXITY_SCALE.length : i;
}

/** True when `a` is at or below `b` on the complexity scale. */
export function complexityAtMost(a: Complexity, b: Complexity): boolean {
  return complexityRank(a) <= complexityRank(b);
}

function envComplexity(): Complexity | undefined {
  const v = process.env["OXAGEN_ROUTING_TRIVIAL_MAX"];
  return v && (COMPLEXITY_SCALE as readonly string[]).includes(v)
    ? (v as Complexity)
    : undefined;
}

/** Highest complexity the coordinator handles itself before dispatching. */
export function getTrivialMaxComplexity(): Complexity {
  return envComplexity() ?? POLICY.config.routing.trivialMaxComplexity;
}

/** Token budget guarding against low-value mid-turn model switches. */
export function getSwitchCostTokenBudget(): number {
  const raw = process.env["OXAGEN_ROUTING_SWITCH_BUDGET"];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : POLICY.config.routing.switchCostTokenBudget;
}

/** The default code worker id (registry `workerModels.defaultCode` — Sonnet 5). */
export function getDefaultCodeWorker(): string {
  return process.env["OXAGEN_ROUTING_CODE_WORKER"] ?? roles().workerModels.defaultCode;
}

/** The cheap basic-work worker id (registry `workerModels.cheapBasic` — Haiku). */
export function getCheapBasicWorker(): string {
  return process.env["OXAGEN_ROUTING_BASIC_WORKER"] ?? roles().workerModels.cheapBasic;
}

/** Base context tokens re-sent on any mid-turn switch (added to prompt tokens). */
export function getExpectedContextTokens(): number {
  return POLICY.switchCostModel.expectedContextTokens;
}

/** Scale converting `qualityGain * taskValue` into a token-equivalent benefit. */
export function getValueTokenScale(): number {
  return POLICY.switchCostModel.valueTokenScale;
}

/** Default task value (0..1) when a task does not supply one. */
export function getDefaultTaskValue(): number {
  return POLICY.switchCostModel.defaultTaskValue;
}
