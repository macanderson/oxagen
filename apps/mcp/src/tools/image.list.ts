import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { imageList } from "@oxagen/oxagen/contracts/image.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...imageList.input.shape,
  workspace_id: imageList.input.shape.workspace_id.describe(
    "Ignored on this surface. Images are always listed for the workspace the " +
      "calling API key is scoped to; the handler reads scope from the request " +
      "context, never from this field.",
  ),
};

export const metadata: ToolMetadata = {
  name: imageList.name,
  description: imageList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function imageListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(imageList.name, args, ctx, { surface: "mcp" });
  return imageList.output.parse(output);
}
