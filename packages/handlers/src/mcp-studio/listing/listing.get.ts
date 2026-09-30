// listing.get.ts: get_studio_listing (ADR-233, #4756).
//
// Studio polls this while a machine lists a draft's tools. Null when the
// draft has no listing.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioListingGet } from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import { authorizeStudio } from "../import/checks";
import { postgresListingStore, type ListingStore } from "./store";
import { listingView } from "./view";

export interface GetStudioListingDeps {
  listings: ListingStore;
  authorize: typeof authorizeStudio;
}

export function createGetStudioListingHandler(
  deps: GetStudioListingDeps,
): CapabilityHandler<typeof toolStudioListingGet> {
  return async (input, ctx) => {
    await deps.authorize(toolStudioListingGet, ctx);
    const listing = await deps.listings.get(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      input.server,
    );
    return { listing: listing === null ? null : listingView(listing) };
  };
}

export const getStudioListingHandler = createGetStudioListingHandler({
  listings: postgresListingStore,
  authorize: authorizeStudio,
});
