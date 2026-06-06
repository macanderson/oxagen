import { Hono } from "hono";
import { pluginOrgSetEnabled } from "@oxagen/oxagen/contracts/plugin.org.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginOrgSetEnabledRoute = new Hono<AppEnv>();

pluginOrgSetEnabledRoute.post("/", async (c) => {
  const body = pluginOrgSetEnabled.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginOrgSetEnabled.name, body, ctx, { surface: "api" });
  return c.json(out);
});
