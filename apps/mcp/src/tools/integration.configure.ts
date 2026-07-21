import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationConfigure } from "@oxagen/oxagen/contracts/integration.configure";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...integrationConfigure.input.shape,
  integrationId:
    integrationConfigure.input.shape.integrationId.describe(
      "Plugin instance ID",
    ),
  displayName: integrationConfigure.input.shape.displayName.describe(
    "Updated display name for the integration",
  ),
  config: integrationConfigure.input.shape.config.describe(
    "Updated config fields (merged with existing)",
  ),
  syncCadence: integrationConfigure.input.shape.syncCadence.describe(
    "Update sync trigger method: manual, polling, or webhook",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationConfigure.name,
  description: integrationConfigure.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function integrationConfigureTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationConfigure.name, args, ctx, {
    surface: "mcp",
  });
  return integrationConfigure.output.parse(output);
}
