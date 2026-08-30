import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { markdownGenerate } from "@oxagen/oxagen/contracts/markdown.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Persist a Markdown document as a first-class generated asset. No cloud OAuth
// required — the operation is fully in-process (UTF-8 encode + blob upload).

export const schema = {
  ...markdownGenerate.input.shape,
  title: markdownGenerate.input.shape.title.describe(
    "Title / filename (without extension) of the output Markdown document",
  ),
  markdown: markdownGenerate.input.shape.markdown.describe(
    "Raw Markdown source. When supplied, this is persisted verbatim.",
  ),
  sections: markdownGenerate.input.shape.sections.describe(
    "Structured sections fallback used when `markdown` is absent. " +
      "Each section emits an H2 heading (if present) followed by paragraphs.",
  ),
};

export const metadata: ToolMetadata = {
  name: markdownGenerate.name,
  description: markdownGenerate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function markdownGenerateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(markdownGenerate.name, args, ctx, {
    surface: "mcp",
  });
  return markdownGenerate.output.parse(output);
}
