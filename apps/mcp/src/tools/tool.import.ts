import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  toolImport,
  toolImportInputObject,
} from "@oxagen/oxagen/contracts/tool.import";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...toolImportInputObject.shape,
  serverId: toolImportInputObject.shape.serverId.describe(
    "The mcs_… server whose tools to import",
  ),
  tools: toolImportInputObject.shape.tools.describe(
    "Names of the server's pinned tools to import; omit for every pinned tool",
  ),
  declarations: toolImportInputObject.shape.declarations.describe(
    "Hand-authored declarations to publish against the server instead of pulling its pins",
  ),
};

export const metadata: ToolMetadata = {
  name: toolImport.name,
  description: toolImport.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolImportTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolImport.name, args, ctx, { surface: "mcp" });
  return toolImport.output.parse(output);
}
