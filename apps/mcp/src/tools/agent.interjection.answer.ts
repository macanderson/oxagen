import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentInterjectionAnswer } from "@oxagen/oxagen/contracts/agent.interjection.answer";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentInterjectionAnswer.input.shape,
  interjectionId: agentInterjectionAnswer.input.shape.interjectionId.describe(
    "The question to answer: its public id (inj_…) or its uuid",
  ),
  answer: agentInterjectionAnswer.input.shape.answer.describe(
    "The free-text answer to an agent's own question, 1 to 4,000 characters. A wrapped run whose host can take it receives it as a message. Leave it out for a repository question, which takes path",
  ),
  path: agentInterjectionAnswer.input.shape.path.describe(
    "For a repository question only: link binds the repository to this workspace, and create makes a new workspace for it with skills off. Needs an org Owner or Admin, or the workspace Owner",
  ),
  create: agentInterjectionAnswer.input.shape.create.describe(
    "With path create only: the new workspace's name and slug",
  ),
};

export const metadata: ToolMetadata = {
  name: agentInterjectionAnswer.name,
  description: agentInterjectionAnswer.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentInterjectionAnswerTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentInterjectionAnswer.name, args, ctx, {
    surface: "mcp",
  });
  return agentInterjectionAnswer.output.parse(output);
}
