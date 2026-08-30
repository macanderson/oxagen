import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillExport } from "@oxagen/oxagen/contracts/skill.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  skillId: skillExport.input.shape.skillId.describe(
    "Public ID of the skill to export (skl_…)",
  ),
  versionNumber: skillExport.input.shape.versionNumber.describe(
    "Version number to export (defaults to active version)",
  ),
};

export const metadata: ToolMetadata = {
  name: skillExport.name,
  description: skillExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillExport.name, args, ctx, { surface: "mcp" });
  return skillExport.output.parse(output);
}
