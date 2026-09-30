// discovery.get.ts: get_studio_discovery (lane M10, #4682).
//
// Studio polls this while a discovery is queued or running, and reads it when
// a server's page opens. A server never discovered answers null.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioDiscoveryGet } from "@oxagen/oxagen/contracts/tool.studio.discovery.get";
import { discoveryActor } from "./discovery.start";
import { readServerDiscovery, type DiscoveryEntryDeps } from "./entry";
import { discoveryView } from "./view";

export function createGetStudioDiscoveryHandler(
  deps: DiscoveryEntryDeps = {},
): CapabilityHandler<typeof toolStudioDiscoveryGet> {
  return async (input, ctx) => {
    const row = await readServerDiscovery(discoveryActor(ctx), input.server, deps);
    return {
      discovery:
        row === null ? null : discoveryView(row, (deps.now ?? (() => new Date()))()),
    };
  };
}

export const getStudioDiscoveryHandler = createGetStudioDiscoveryHandler();
