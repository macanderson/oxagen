import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationDisable } from "@oxagen/oxagen/contracts/automation.disable";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...automationDisable.input.shape,
  automation_id: automationDisable.input.shape.automation_id.describe(
    "Trigger public ID returned by create_automation / list_automations",
  ),
};

export const metadata: ToolMetadata = {
  name: automationDisable.name,
  description: automationDisable.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function automationDisableTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationDisable.name, args, ctx, {
    surface: "mcp",
  });
  return automationDisable.output.parse(output);
}
