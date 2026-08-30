import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { svgGenerate } from "@oxagen/oxagen/contracts/svg.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Generate clean, sanitized inline SVG from a natural-language prompt.
// Script tags and inline event handlers are stripped before output is returned.

export const schema = {
  ...svgGenerate.input.shape,
  prompt: svgGenerate.input.shape.prompt.describe(
    "Natural-language description of the SVG to generate",
  ),
  title: svgGenerate.input.shape.title.describe(
    "Optional accessible title. Derived from prompt if omitted.",
  ),
  width: svgGenerate.input.shape.width.describe(
    "Optional width hint in pixels (default 400)",
  ),
  height: svgGenerate.input.shape.height.describe(
    "Optional height hint in pixels (default 400)",
  ),
};

export const metadata: ToolMetadata = {
  name: svgGenerate.name,
  description: svgGenerate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function svgGenerateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(svgGenerate.name, args, ctx, { surface: "mcp" });
  return svgGenerate.output.parse(output);
}
