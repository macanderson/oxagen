// draft.get.ts: get_studio_draft (lane M11, ADR-224).
//
// Studio reads the stored draft when a page opens and after a save is refused
// as stale. The source comes back as its type and size, never its text.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioDraftGet } from "@oxagen/oxagen/contracts/tool.studio.draft.get";
import { authorizeStudio } from "./checks";
import { draftView, postgresStudioDraftStore, type StudioDraftStore } from "./store";

export interface GetStudioDraftDeps {
  store: StudioDraftStore;
  authorize: typeof authorizeStudio;
}

export function createGetStudioDraftHandler(
  deps: GetStudioDraftDeps,
): CapabilityHandler<typeof toolStudioDraftGet> {
  return async (input, ctx) => {
    await deps.authorize(toolStudioDraftGet, ctx);
    const draft = await deps.store.get(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      input.server,
    );
    return { draft: draft === null ? null : draftView(draft) };
  };
}

export const getStudioDraftHandler = createGetStudioDraftHandler({
  store: postgresStudioDraftStore(),
  authorize: authorizeStudio,
});
