import { Hono } from "hono";
import { pluginOrgInstallBulk } from "@oxagen/oxagen/contracts/plugin.org.install_bulk";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginOrgInstallBulkRoute = new Hono<AppEnv>();

pluginOrgInstallBulkRoute.post("/", async (c) => {
  const body = pluginOrgInstallBulk.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginOrgInstallBulk.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
