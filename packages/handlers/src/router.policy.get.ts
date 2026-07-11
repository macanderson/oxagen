import type { CapabilityHandler } from "@oxagen/oxagen";
import { routerPolicyGet } from "@oxagen/oxagen/contracts/router.policy.get";
import { loadEffectiveRoutingPolicy } from "./lib/routing-policy";

// get_routing_policy — resolve the effective market-router policy for the current
// scope (workspace row > org-default row > OFF default) and report its provenance.
export const routerPolicyGetHandler: CapabilityHandler<
  typeof routerPolicyGet
> = async (_input, ctx) => {
  const { policy, source } = await loadEffectiveRoutingPolicy(ctx);
  return {
    mode: policy.mode,
    successThreshold: policy.successThreshold,
    minSamples: policy.minSamples,
    windowDays: policy.windowDays,
    escalateOnRejection: policy.escalateOnRejection,
    source,
  };
};
