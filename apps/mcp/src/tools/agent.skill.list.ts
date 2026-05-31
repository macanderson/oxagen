import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSkillList } from "@oxagen/oxagen/contracts/agent.skill.list";
import { agentSkillListHandler } from "@oxagen/agent/handlers/agent.skill.list";
import { buildContext } from "../context.js";

export const schema = {
  filter: z.string().optional().describe("Optional name/slug filter"),
};

export const metadata: ToolMetadata = {
  name: agentSkillList.name,
  description: agentSkillList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSkillListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = buildContext(headers());
  const output = await agentSkillListHandler(args, ctx);
  return agentSkillList.output.parse(output);
}
