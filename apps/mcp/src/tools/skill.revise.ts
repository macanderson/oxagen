import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillRevise } from "@oxagen/oxagen/contracts/skill.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  skill_id: skillRevise.input.shape.skill_id.describe(
    "Public ID of the skill to revise (skl_…).",
  ),
  prompt: skillRevise.input.shape.prompt.describe(
    "Plain-language description of the change to make (10–4000 characters), e.g. 'tighten the incident-response steps to five bullets and add a rollback section'.",
  ),
  activate: skillRevise.input.shape.activate.describe(
    "Set the new version active immediately (default: true). Pass false to stage it without going live.",
  ),
  workspace_id: skillRevise.input.shape.workspace_id.describe(
    "Ignored on this surface. The handler resolves the workspace from the " +
      "calling API key's request context, never from this field.",
  ),
};

export const metadata: ToolMetadata = {
  name: skillRevise.name,
  description: skillRevise.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function skillReviseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillRevise.name, args, ctx, { surface: "mcp" });
  return skillRevise.output.parse(output);
}
