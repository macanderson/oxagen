import type { CapabilityHandler } from "@oxagen/oxagen";
import { routerStatsList } from "@oxagen/oxagen/contracts/router.stats.list";
import { summarizeRoutingStats } from "@oxagen/agent-engine";
import { readRoutingStats } from "@oxagen/telemetry";
import { loadEffectiveRoutingPolicy } from "./lib/routing-policy";

// list_routing_stats — the Pareto-curve read. Reads observed outcomes per (task
// class, model) over a window, then derives the cheapest-eligible-per-class
// summary under the effective policy. Window/minSamples default to the effective
// policy's when not supplied.
export const routerStatsListHandler: CapabilityHandler<
  typeof routerStatsList
> = async (input, ctx) => {
  const { policy } = await loadEffectiveRoutingPolicy(ctx);
  const windowDays = input.windowDays ?? policy.windowDays;
  const minSamples = input.minSamples ?? policy.minSamples;

  const rows = await readRoutingStats({
    taskClass: input.taskClass,
    windowDays,
    minSamples,
  });

  // Summarize using the EFFECTIVE policy's threshold + minSamples so the
  // "cheapest clearing the bar" matches what enforce mode would actually pick.
  const summary = summarizeRoutingStats(rows, {
    ...policy,
    minSamples,
  });

  return {
    rows,
    summary,
    window: {
      windowDays,
      minSamples,
      successThreshold: policy.successThreshold,
    },
  };
};
