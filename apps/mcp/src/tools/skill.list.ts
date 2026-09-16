import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...skillList.input.shape,
  windowDays: skillList.input.shape.windowDays.describe(
    "Sessions started in the last N days, 1 to 90; default 30",
  ),
  cursor: skillList.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
};

export const metadata: ToolMetadata = {
  name: skillList.name,
  description: skillList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillList.name, args, ctx, {
    surface: "mcp",
  });
  return skillList.output.parse(output);
}
