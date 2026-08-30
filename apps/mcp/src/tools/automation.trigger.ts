import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationTrigger } from "@oxagen/oxagen/contracts/automation.trigger";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...automationTrigger.input.shape,
  automation_id: automationTrigger.input.shape.automation_id.describe(
    "ID of the automation to trigger",
  ),
  payload: automationTrigger.input.shape.payload.describe(
    "Optional payload to pass to the automation",
  ),
};

export const metadata: ToolMetadata = {
  name: automationTrigger.name,
  description: automationTrigger.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function automationTriggerTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationTrigger.name, args, ctx, {
    surface: "mcp",
  });
  return automationTrigger.output.parse(output);
}
