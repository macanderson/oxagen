import { Hono } from "hono";
import { pluginOrgInstall } from "@oxagen/oxagen/contracts/plugin.org.install";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginOrgInstallRoute = new Hono<AppEnv>();

pluginOrgInstallRoute.post("/", async (c) => {
  const body = pluginOrgInstall.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginOrgInstall.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
