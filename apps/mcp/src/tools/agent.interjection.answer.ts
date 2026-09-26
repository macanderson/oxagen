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
    "The answer, 1 to 4,000 characters. A wrapped run whose host can take it receives it as a message",
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
