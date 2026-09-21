import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = { ...skillSearchPreview.input.shape };
export const metadata: ToolMetadata = {
  name: skillSearchPreview.name,
  description: skillSearchPreview.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const output = await invoke(
    skillSearchPreview.name,
    args,
    await buildContext(headers()),
    { surface: "mcp" },
  );
  return skillSearchPreview.output.parse(output);
}
