// discovery.start.ts: start_studio_discovery (lane M10, #4682).
//
// Studio's Sync now button and Add server call this. The server is marked
// queued and one discovery event goes out. Studio then polls
// get_studio_discovery for the run's progress.
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioDiscoveryStart } from "@oxagen/oxagen/contracts/tool.studio.discovery.start";
import {
  startServerDiscovery,
  type DiscoveryActor,
  type DiscoveryEntryDeps,
} from "./entry";
import { discoveryView } from "./view";

/** The caller, as the discovery entry points read it. */
export function discoveryActor(ctx: CapabilityContext): DiscoveryActor {
  return {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
  };
}

export function createStartStudioDiscoveryHandler(
  deps: DiscoveryEntryDeps = {},
): CapabilityHandler<typeof toolStudioDiscoveryStart> {
  return async (input, ctx) => {
    const row = await startServerDiscovery(discoveryActor(ctx), input.server, deps);
    // The request upserts the row, so a missing row means the write failed.
    if (row === null) {
      throw new Error(`The discovery request for ${input.server} left no row.`);
    }
    return { discovery: discoveryView(row, (deps.now ?? (() => new Date()))()) };
  };
}

export const startStudioDiscoveryHandler = createStartStudioDiscoveryHandler();
