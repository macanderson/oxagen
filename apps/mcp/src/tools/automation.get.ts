import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationGet } from "@oxagen/oxagen/contracts/automation.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...automationGet.input.shape,
  automation_id: automationGet.input.shape.automation_id.describe(
    "Trigger public ID (plt_*) from list_automations",
  ),
};

export const metadata: ToolMetadata = {
  name: automationGet.name,
  description: automationGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function automationGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationGet.name, args, ctx, {
    surface: "mcp",
  });
  return automationGet.output.parse(output);
}
