import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  toolStudioDraftSave,
  toolStudioDraftSaveInputObject,
} from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

// The contract input is refined, so it has no `.shape`. The base object
// carries the fields, and invoke() re-parses the refined input on the call.
export const schema = {
  ...toolStudioDraftSaveInputObject.shape,
  server: toolStudioDraftSaveInputObject.shape.server.describe(
    "The server folder under tools/servers/, which is the server's name",
  ),
  serverId: toolStudioDraftSaveInputObject.shape.serverId.describe(
    "The mcs_… id of the registered server. Omit for a server not yet registered",
  ),
  ops: toolStudioDraftSaveInputObject.shape.ops.describe(
    "Every staged edit: import, remove, classify, describe, or test. The list replaces the stored one",
  ),
  serverToml: toolStudioDraftSaveInputObject.shape.serverToml.describe(
    "server.toml as Studio authored it. Omit to keep the stored one",
  ),
  source: toolStudioDraftSaveInputObject.shape.source.describe(
    "The MCP tool list or the OpenAPI, GraphQL, or gRPC definition the draft imports from. Omit to keep the stored one",
  ),
  revision: toolStudioDraftSaveInputObject.shape.revision.describe(
    "The revision this save builds on, 0 for a new draft. A save over a different revision is refused",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioDraftSave.name,
  description: toolStudioDraftSave.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function toolStudioDraftSaveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioDraftSave.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(toolStudioDraftSave.output.parse(output));
}
