import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentRead } from "@oxagen/oxagen/contracts/document.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...documentRead.input.shape,
  document_id: documentRead.input.shape.document_id.describe(
    "ID of the document to read",
  ),
};

export const metadata: ToolMetadata = {
  name: documentRead.name,
  description: documentRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function documentReadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentRead.name, args, ctx, { surface: "mcp" });
  return documentRead.output.parse(output);
}
