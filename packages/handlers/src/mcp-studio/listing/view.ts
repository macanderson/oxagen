// view.ts: a stored listing as get_studio_listing and start_studio_listing
// return it (ADR-233, #4756).
import type {
  StudioListedTool,
  StudioListing,
} from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import type { StoredListing } from "./store";

/** The pin a lock source records, as Studio shows it. */
function pinOf(listing: StoredListing): StudioListing["pin"] {
  const { lockSource } = listing;
  if (lockSource.type === "local") {
    const { name, version, digest } = lockSource.package;
    return { name, version, digest, registryType: null };
  }
  if (lockSource.type === "registry" && lockSource.package !== undefined) {
    const { name, version, digest, registry_type } = lockSource.package;
    return { name, version, digest, registryType: registry_type };
  }
  // A listing pins a package or a command. A lock source with neither was
  // stored by mistake, and Studio shows it as unpinned.
  return { name: listing.server, version: "", digest: "", registryType: null };
}

/** The listing as Studio shows it. `tools` are the listed tools, read from the draft (listed.ts). */
export function listingView(
  listing: StoredListing,
  tools: StudioListedTool[] | null = null,
): StudioListing {
  return {
    server: listing.server,
    status: listing.status,
    machineGroups: listing.machineGroups,
    pin: pinOf(listing),
    draftRevision: listing.draftRevision,
    requestedAt: listing.requestedAt.toISOString(),
    requestedBy: listing.requestedBy,
    claimedAt: listing.claimedAt?.toISOString() ?? null,
    finishedAt: listing.finishedAt?.toISOString() ?? null,
    machine: listing.machine,
    toolCount: listing.toolCount,
    error: listing.error,
    tools,
  };
}
