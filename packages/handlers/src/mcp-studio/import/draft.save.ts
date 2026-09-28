// draft.save.ts: save_studio_draft (lane M11, ADR-224).
//
// Studio keeps a person's unsaved edits to one server folder as a draft in
// Oxagen until Review. A save replaces the stored ops, and server.toml and the
// source when the input carries them. The revision rule is store.ts's: 0
// starts a draft and never overwrites one, and N must match the stored one.
//
// Every check runs before the write, so a refused save stores nothing: a test
// that holds a credential or makes no recorded exchange, and a server.toml
// that does not parse or names another server.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioDraftSave } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { parseServerToml } from "@oxagen/mcp-studio";
import { authorizeStudio, checkTests, describeIssues } from "./checks";
import { draftView, postgresStudioDraftStore, type StudioDraftStore } from "./store";

export interface SaveStudioDraftDeps {
  store: StudioDraftStore;
  authorize: typeof authorizeStudio;
}

/** Refuse a server.toml that does not parse or names another server. */
export function checkServerToml(server: string, text: string): void {
  const read = parseServerToml(text);
  if (!read.ok) {
    throw new HandlerError({
      code: "conflict",
      reason: "server_toml_invalid",
      message: `server.toml does not parse. ${describeIssues(read.issues)}`,
    });
  }
  if (read.value.name !== server) {
    throw new HandlerError({
      code: "conflict",
      reason: "server_name_mismatch",
      message: `server.toml names ${read.value.name}, and the draft is for ${server}. The name in server.toml is the folder's name.`,
    });
  }
}

export function createSaveStudioDraftHandler(
  deps: SaveStudioDraftDeps,
): CapabilityHandler<typeof toolStudioDraftSave> {
  return async (input, ctx) => {
    const actorUserId = await deps.authorize(toolStudioDraftSave, ctx);
    checkTests(input.ops);
    if (input.serverToml !== undefined) checkServerToml(input.server, input.serverToml);

    const saved = await deps.store.save(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      {
        server: input.server,
        serverId: input.serverId,
        ops: input.ops,
        serverToml: input.serverToml,
        source: input.source,
        revision: input.revision,
        actorUserId,
      },
    );
    return draftView(saved);
  };
}

export const saveStudioDraftHandler = createSaveStudioDraftHandler({
  store: postgresStudioDraftStore(),
  authorize: authorizeStudio,
});
