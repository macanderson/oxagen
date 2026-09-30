// listing.start.ts: start_studio_listing (ADR-233, #4756).
//
// Studio's Local command and registry package forms call this after they
// save the draft's server.toml. The handler reads the draft, pins its server
// (pin.ts), and records one listing that waits for a machine in the server's
// groups. The MCP process that holds such a machine's poll claims it
// (claim.ts). Studio then polls get_studio_listing, and reads the draft again
// once the listing succeeds.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolStudioListingStart } from "@oxagen/oxagen/contracts/tool.studio.listing.start";
import { registryDigests, type RegistryDigests } from "../discovery/digests";
import { cloudRegistryCatalog, type RegistryCatalog } from "../discovery/seams";
import { authorizeStudio } from "../import/checks";
import { postgresStudioDraftStore, staleRevision, type StudioDraftStore } from "../import/store";
import { draftSource, pinListing } from "./pin";
import { postgresListingStore, type ListingStore } from "./store";
import { listingView } from "./view";

/** How long pinning a registry package may take: one catalog read and one digest read. */
export const PIN_TIMEOUT_MS = 30_000;

export interface StartStudioListingDeps {
  drafts: StudioDraftStore;
  listings: ListingStore;
  authorize: typeof authorizeStudio;
  catalog: () => RegistryCatalog;
  digests: () => RegistryDigests;
  now: () => Date;
}

export function createStartStudioListingHandler(
  deps: StartStudioListingDeps,
): CapabilityHandler<typeof toolStudioListingStart> {
  return async (input, ctx) => {
    const actorUserId = await deps.authorize(toolStudioListingStart, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const draft = await deps.drafts.get(scope, input.server);
    if (draft === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "draft_not_found",
        message: `No draft for ${input.server} exists. Save one with its server.toml, then list its tools.`,
      });
    }
    // Refused before any registry read: a pin for another revision's
    // server.toml is not the one the person sees.
    if (draft.revision !== input.revision) {
      throw staleRevision(
        `The draft for ${input.server} is at revision ${draft.revision}, not ${input.revision}. Read it again, then list its tools.`,
      );
    }
    const source = draftSource(input.server, draft.serverToml);
    const pinned = await pinListing(input.server, source, input.pin, {
      catalog: deps.catalog(),
      digests: deps.digests(),
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
    });
    // The store checks the revision again under the draft's row lock, so a
    // save that lands during the registry read is refused, not overwritten.
    const listing = await deps.listings.request(
      scope,
      {
        server: input.server,
        draftRevision: input.revision,
        groups: pinned.groups,
        lockSource: pinned.lockSource,
        requestedBy: actorUserId,
      },
      deps.now(),
    );
    return { listing: listingView(listing) };
  };
}

export const startStudioListingHandler = createStartStudioListingHandler({
  drafts: postgresStudioDraftStore(),
  listings: postgresListingStore,
  authorize: authorizeStudio,
  catalog: cloudRegistryCatalog,
  digests: () => registryDigests(),
  now: () => new Date(),
});
