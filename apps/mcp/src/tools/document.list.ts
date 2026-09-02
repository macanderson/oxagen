import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentList } from "@oxagen/oxagen/contracts/document.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...documentList.input.shape,
  workspace_id: documentList.input.shape.workspace_id.describe(
    "Workspace ID (defaults to current workspace)",
  ),
};

export const metadata: ToolMetadata = {
  name: documentList.name,
  description: documentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function documentListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentList.name, args, ctx, { surface: "mcp" });
  return documentList.output.parse(output);
}
