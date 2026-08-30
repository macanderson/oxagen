import { Hono } from "hono";
import { pluginCatalogSync } from "@oxagen/oxagen/contracts/plugin.catalog.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginCatalogSyncRoute = new Hono<AppEnv>();

pluginCatalogSyncRoute.post("/", async (c) => {
  const body = pluginCatalogSync.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginCatalogSync.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
