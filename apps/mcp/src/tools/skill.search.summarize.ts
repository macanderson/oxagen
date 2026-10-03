import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillSearchSummarize } from "@oxagen/oxagen/contracts/skill.search.summarize";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";
export const schema = { ...skillSearchSummarize.input.shape };
export const metadata: ToolMetadata = {
  name: skillSearchSummarize.name,
  description: skillSearchSummarize.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const output = await invoke(
    skillSearchSummarize.name,
    args,
    await buildContext(headers()),
    { surface: "mcp" },
  );
  return toolResult(skillSearchSummarize.output.parse(output));
}
