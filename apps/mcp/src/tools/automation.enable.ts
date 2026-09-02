import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationEnable } from "@oxagen/oxagen/contracts/automation.enable";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...automationEnable.input.shape,
  automation_id: automationEnable.input.shape.automation_id.describe(
    "Trigger public ID returned by create_automation / list_automations",
  ),
};

export const metadata: ToolMetadata = {
  name: automationEnable.name,
  description: automationEnable.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function automationEnableTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationEnable.name, args, ctx, {
    surface: "mcp",
  });
  return automationEnable.output.parse(output);
}
