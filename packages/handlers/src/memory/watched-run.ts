// The one check both memory capture handlers make (ADR-206).
//
// Oxagen attributes a memory to the run it watched. The local gateway names
// that run's daemon chain on a tacho_gateway_v1 key, and the kernel carries it
// as ctx.gatewaySessionUuid. A caller without it, such as a script holding an
// API key or a harness connected to Oxagen directly, has no watched run.
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";

export function assertWatchedRun(
  ctx: Pick<CapabilityContext, "gatewaySessionUuid">,
  capability: string,
): void {
  if (ctx.gatewaySessionUuid) return;
  throw new HandlerError({
    code: "forbidden",
    reason: "no_watched_run",
    message: `${capability} needs a run Oxagen watches. Call it through the Oxagen local gateway from a harness with Tacho installed.`,
  });
}
