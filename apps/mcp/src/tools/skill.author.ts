import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillAuthor } from "@oxagen/oxagen/contracts/skill.author";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  prompt: skillAuthor.input.shape.prompt.describe(
    "Natural-language description of what the skill should teach the agent (10–4000 characters).",
  ),
  nameHint: skillAuthor.input.shape.nameHint.describe(
    "Optional preferred kebab-case slug (e.g. 'pr-review'). Derived from the prompt when omitted.",
  ),
  category: skillAuthor.input.shape.category.describe(
    "Optional category label (e.g. 'engineering', 'writing', 'meta').",
  ),
  activate: skillAuthor.input.shape.activate.describe(
    "Activate the new skill version immediately (default: true).",
  ),
  workspace_id: skillAuthor.input.shape.workspace_id.describe(
    "Workspace ID (defaults to current workspace).",
  ),
};

export const metadata: ToolMetadata = {
  name: skillAuthor.name,
  description: skillAuthor.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function skillAuthorTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillAuthor.name, args, ctx, { surface: "mcp" });
  return skillAuthor.output.parse(output);
}
