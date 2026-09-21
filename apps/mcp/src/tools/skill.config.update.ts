import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillConfigUpdate } from "@oxagen/oxagen/contracts/skill.config.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = { ...skillConfigUpdate.input.shape };
export const metadata: ToolMetadata = {
  name: skillConfigUpdate.name,
  description: skillConfigUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const output = await invoke(
    skillConfigUpdate.name,
    args,
    await buildContext(headers()),
    { surface: "mcp" },
  );
  return skillConfigUpdate.output.parse(output);
}
