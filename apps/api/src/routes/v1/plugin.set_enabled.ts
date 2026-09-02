import { Hono } from "hono";
import { pluginSetEnabled } from "@oxagen/oxagen/contracts/plugin.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginSetEnabledRoute = new Hono<AppEnv>();

pluginSetEnabledRoute.post("/", async (c) => {
  const body = pluginSetEnabled.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSetEnabled.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
