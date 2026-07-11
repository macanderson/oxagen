import type { CapabilityHandler } from "@oxagen/oxagen";
import { routerDecisionPreview } from "@oxagen/oxagen/contracts/router.decision.preview";
import {
  decideMarketRoute,
  deriveTaskClass,
  normalizeRoutingPolicy,
} from "@oxagen/agent-engine";
import { readRoutingStats } from "@oxagen/telemetry";
import { loadEffectiveRoutingPolicy } from "./lib/routing-policy";

// preview_routing_decision — a pure dry run: derive the task class, read observed
// stats, and return the full market decision the router WOULD make under the
// effective policy plus any per-call overrides. Reads only; changes nothing.
export const routerDecisionPreviewHandler: CapabilityHandler<
  typeof routerDecisionPreview
> = async (input, ctx) => {
  const signals = {
    text: input.prompt,
    fileCount: input.fileCount,
    crossPackage: input.crossPackage,
  };
  const taskClass = input.taskClass ?? deriveTaskClass(signals);

  const { policy: effective } = await loadEffectiveRoutingPolicy(ctx);
  // Overlay per-call overrides on the effective policy for this preview only.
  const policy = normalizeRoutingPolicy({
    mode: input.mode ?? effective.mode,
    successThreshold: input.successThreshold ?? effective.successThreshold,
    minSamples: input.minSamples ?? effective.minSamples,
    windowDays: input.windowDays ?? effective.windowDays,
    escalateOnRejection:
      input.escalateOnRejection ?? effective.escalateOnRejection,
  });

  const stats = await readRoutingStats({
    taskClass,
    windowDays: policy.windowDays,
    minSamples: policy.minSamples,
  });

  const decision = decideMarketRoute({ signals, taskClass, stats, policy });

  return {
    tier: decision.tier,
    model: decision.model,
    rationale: decision.rationale,
    source: decision.source,
    taskClass: decision.taskClass,
    candidates: decision.candidates,
    policySnapshot: decision.policySnapshot,
  };
};
