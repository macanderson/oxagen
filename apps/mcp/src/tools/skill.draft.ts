import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillDraft } from "@oxagen/oxagen/contracts/skill.draft";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  prompt: skillDraft.input.shape.prompt.describe(
    "Natural-language description of what the skill should teach the agent (10–4000 characters).",
  ),
  nameHint: skillDraft.input.shape.nameHint.describe(
    "Optional preferred kebab-case slug (e.g. 'pr-review'). Derived from the prompt when omitted.",
  ),
  category: skillDraft.input.shape.category.describe(
    "Optional category label (e.g. 'engineering', 'writing', 'meta').",
  ),
};

export const metadata: ToolMetadata = {
  name: skillDraft.name,
  description: skillDraft.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function skillDraftTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillDraft.name, args, ctx, { surface: "mcp" });
  return skillDraft.output.parse(output);
}
