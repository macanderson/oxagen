import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationUpdate } from "@oxagen/oxagen/contracts/automation.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...automationUpdate.input.shape,
  automation_id: automationUpdate.input.shape.automation_id.describe(
    "Trigger public ID returned by create_automation / list_automations",
  ),
};

export const metadata: ToolMetadata = {
  name: automationUpdate.name,
  description: automationUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function automationUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return automationUpdate.output.parse(output);
}
