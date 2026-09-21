import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = { ...skillConfigGet.input.shape };
export const metadata: ToolMetadata = {
  name: skillConfigGet.name,
  description: skillConfigGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const output = await invoke(
    skillConfigGet.name,
    args,
    await buildContext(headers()),
    { surface: "mcp" },
  );
  return skillConfigGet.output.parse(output);
}
