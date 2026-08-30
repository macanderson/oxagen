import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { imageGenerate } from "@oxagen/oxagen/contracts/image.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Image generation via the Vercel AI Gateway when AI_GATEWAY_API_KEY is configured; returns a
// typed placeholder with an empty-state render directive otherwise. Never throws.

export const schema = {
  ...imageGenerate.input.shape,
  prompt: imageGenerate.input.shape.prompt.describe(
    "Natural-language description of the image to generate",
  ),
  alt: imageGenerate.input.shape.alt.describe(
    "Accessible alt text. Derived from prompt if omitted.",
  ),
  size: imageGenerate.input.shape.size.describe(
    "Image dimensions. Supported values: 1024x1024, 1792x1024, 1024x1792",
  ),
};

export const metadata: ToolMetadata = {
  name: imageGenerate.name,
  description: imageGenerate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function imageGenerateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(imageGenerate.name, args, ctx, {
    surface: "mcp",
  });
  return imageGenerate.output.parse(output);
}
