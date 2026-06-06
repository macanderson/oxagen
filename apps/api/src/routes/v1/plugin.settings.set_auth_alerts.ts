import { Hono } from "hono";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginSettingsSetAuthAlertsRoute = new Hono<AppEnv>();

pluginSettingsSetAuthAlertsRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = pluginSettingsSetAuthAlerts.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSettingsSetAuthAlerts.name, input, ctx, { surface: "api" });
  return c.json(out);
});
