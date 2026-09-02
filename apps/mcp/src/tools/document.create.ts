import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentCreate } from "@oxagen/oxagen/contracts/document.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...documentCreate.input.shape,
  title: documentCreate.input.shape.title.describe("Document title"),
  content: documentCreate.input.shape.content.describe(
    "Initial document content (optional)",
  ),
};

export const metadata: ToolMetadata = {
  name: documentCreate.name,
  description: documentCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function documentCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentCreate.name, args, ctx, {
    surface: "mcp",
  });
  return documentCreate.output.parse(output);
}
