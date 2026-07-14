import { Hono } from "hono";
import { pluginSettingsGetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.get_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginSettingsGetAuthAlertsRoute = new Hono<AppEnv>();

pluginSettingsGetAuthAlertsRoute.get("/", async (c) => {
  const input = pluginSettingsGetAuthAlerts.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSettingsGetAuthAlerts.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
