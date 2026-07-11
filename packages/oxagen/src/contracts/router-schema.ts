import { z } from "zod";

// Shared Zod pieces for the Verified-Outcome Market Router contracts
// (get_routing_policy / set_routing_policy / list_routing_stats /
// preview_routing_decision). Not capabilities themselves — re-exported from
// contracts/index.ts so the check-contracts file-coverage guard sees this file
// referenced, mirroring eval-schema.ts. Keeping the shapes here keeps the policy
// definition identical everywhere it appears (get output, set in/out, preview
// snapshot).

/** Router mode: off (deterministic), shadow (learn), enforce (act). */
export const routingModeSchema = z.enum(["off", "shadow", "enforce"]);
export type RoutingMode = z.output<typeof routingModeSchema>;

/** Which scope supplied the effective policy. */
export const routingPolicySourceSchema = z.enum([
  "workspace",
  "org",
  "default",
]);

/** Which scope a set_routing_policy write targets. */
export const routingPolicyScopeSchema = z.enum(["org", "workspace"]);

/** Whether a route came from a real market clearing or the deterministic fallback. */
export const marketRouteSourceSchema = z.enum([
  "market",
  "deterministic-fallback",
]);

/** The resolved / stored routing policy tunables. */
export const routingPolicySchema = z.object({
  mode: routingModeSchema,
  successThreshold: z.number().min(0).max(1),
  minSamples: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
  escalateOnRejection: z.boolean(),
});
export type RoutingPolicyShape = z.output<typeof routingPolicySchema>;

/** One (task_class, model) observed-outcome aggregate (the Pareto-curve row). */
export const routingStatRowSchema = z.object({
  taskClass: z.string(),
  model: z.string(),
  tier: z.string(),
  samples: z.number().int().nonnegative(),
  verifiedCount: z.number().int().nonnegative(),
  verifiedRate: z.number(),
  avgCostUsdMicros: z.number(),
  avgLatencyMs: z.number(),
  lastSeen: z.string(),
});

/** One model weighed in a market decision, with its eligibility reason. */
export const marketCandidateSchema = z.object({
  model: z.string(),
  verifiedRate: z.number(),
  samples: z.number().int().nonnegative(),
  avgCostUsdMicros: z.number(),
  eligible: z.boolean(),
  reason: z.string(),
});
