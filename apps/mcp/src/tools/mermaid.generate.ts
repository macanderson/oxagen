import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { mermaidGenerate } from "@oxagen/oxagen/contracts/mermaid.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Produce a Mermaid diagram returned as an inline chat artifact.
// The diagram source is validated server-side and rendered client-side in the browser.

export const schema = {
  ...mermaidGenerate.input.shape,
  title: mermaidGenerate.input.shape.title.describe(
    "Human-readable title for the diagram — shown in the card heading",
  ),
  diagram: mermaidGenerate.input.shape.diagram.describe(
    "Mermaid diagram source text (e.g. 'flowchart TD\\n  A --> B'). Max 50,000 chars.",
  ),
  theme: mermaidGenerate.input.shape.theme.describe(
    "Optional Mermaid theme: 'default' | 'dark' | 'neutral' | 'forest'. Defaults to 'default'.",
  ),
};

export const metadata: ToolMetadata = {
  name: mermaidGenerate.name,
  description: mermaidGenerate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function mermaidGenerateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(mermaidGenerate.name, args, ctx, {
    surface: "mcp",
  });
  return mermaidGenerate.output.parse(output);
}
