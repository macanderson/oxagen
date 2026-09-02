import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { systemInstallInstructions } from "@oxagen/oxagen/contracts/system.install.instructions";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Returns step-by-step MCP/CLI install instructions for a given AI client.
// Pure computation — no model call. Renders inline via the install-instructions
// chat component.

export const schema = {
  ...systemInstallInstructions.input.shape,
  client: systemInstallInstructions.input.shape.client.describe(
    "AI client to generate installation instructions for (claude-code, cursor, claude-desktop, codex, vscode)",
  ),
  workspaceSlug: systemInstallInstructions.input.shape.workspaceSlug.describe(
    "Optional workspace slug for personalised config snippets",
  ),
};

export const metadata: ToolMetadata = {
  name: systemInstallInstructions.name,
  description: systemInstallInstructions.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function systemInstallInstructionsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(systemInstallInstructions.name, args, ctx, {
    surface: "mcp",
  });
  return systemInstallInstructions.output.parse(output);
}
