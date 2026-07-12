import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSettingsGetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.get_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginSettingsGetAuthAlerts.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginSettingsGetAuthAlerts.name,
  description: pluginSettingsGetAuthAlerts.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginSettingsGetAuthAlertsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSettingsGetAuthAlerts.name, args, ctx, {
    surface: "mcp",
  });
  return pluginSettingsGetAuthAlerts.output.parse(output);
}
