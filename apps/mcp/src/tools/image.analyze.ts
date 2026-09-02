import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { imageAnalyze } from "@oxagen/oxagen/contracts/image.analyze";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...imageAnalyze.input.shape,
  image_id: imageAnalyze.input.shape.image_id.describe(
    "ID of the image to analyze",
  ),
};

export const metadata: ToolMetadata = {
  name: imageAnalyze.name,
  description: imageAnalyze.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function imageAnalyzeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(imageAnalyze.name, args, ctx, { surface: "mcp" });
  return imageAnalyze.output.parse(output);
}
