import { Hono } from "hono";
import { pluginOrgUninstall } from "@oxagen/oxagen/contracts/plugin.org.uninstall";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginOrgUninstallRoute = new Hono<AppEnv>();

pluginOrgUninstallRoute.post("/", async (c) => {
  const body = pluginOrgUninstall.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginOrgUninstall.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
