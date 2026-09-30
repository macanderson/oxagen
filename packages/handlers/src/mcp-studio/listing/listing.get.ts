// listing.get.ts: get_studio_listing (ADR-233, #4756).
//
// Studio polls this while a machine lists a draft's tools. Null when the
// draft has no listing. Once the listing succeeds, the answer carries the
// tools the machine listed, read from the draft (listed.ts), so Add server
// can import and classify them before Review.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioListingGet } from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import { authorizeStudio } from "../import/checks";
import { postgresStudioDraftStore, type StudioDraftStore } from "../import/store";
import { listedTools } from "./listed";
import { postgresListingStore, type ListingStore } from "./store";
import { listingView } from "./view";

export interface GetStudioListingDeps {
  listings: ListingStore;
  drafts: StudioDraftStore;
  authorize: typeof authorizeStudio;
}

export function createGetStudioListingHandler(
  deps: GetStudioListingDeps,
): CapabilityHandler<typeof toolStudioListingGet> {
  return async (input, ctx) => {
    await deps.authorize(toolStudioListingGet, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const listing = await deps.listings.get(scope, input.server);
    if (listing === null) return { listing: null };
    // Only a succeeded listing has tools to show, so only it reads the draft.
    const draft =
      listing.status === "succeeded"
        ? await deps.drafts.get(scope, input.server)
        : null;
    return { listing: listingView(listing, await listedTools(listing, draft)) };
  };
}

export const getStudioListingHandler = createGetStudioListingHandler({
  listings: postgresListingStore,
  drafts: postgresStudioDraftStore(),
  authorize: authorizeStudio,
});
