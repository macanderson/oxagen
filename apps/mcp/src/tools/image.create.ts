import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { imageCreate } from "@oxagen/oxagen/contracts/image.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...imageCreate.input.shape,
  prompt: imageCreate.input.shape.prompt.describe(
    "Natural-language prompt describing the image to generate",
  ),
  model: imageCreate.input.shape.model.describe(
    "Image model: gpt-image-1 | flux-2-max. Defaults to gpt-image-1.",
  ),
  size: imageCreate.input.shape.size.describe(
    "Image dimensions (e.g. 1024x1024)",
  ),
};

export const metadata: ToolMetadata = {
  name: imageCreate.name,
  description: imageCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function imageCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(imageCreate.name, args, ctx, { surface: "mcp" });
  return imageCreate.output.parse(output);
}
