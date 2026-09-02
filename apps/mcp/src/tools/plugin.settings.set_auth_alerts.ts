import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...pluginSettingsSetAuthAlerts.input.shape };

export const metadata: ToolMetadata = {
  name: pluginSettingsSetAuthAlerts.name,
  description: pluginSettingsSetAuthAlerts.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginSettingsSetAuthAlertsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSettingsSetAuthAlerts.name, args, ctx, {
    surface: "mcp",
  });
  return pluginSettingsSetAuthAlerts.output.parse(output);
}
