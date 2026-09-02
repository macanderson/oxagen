import { Hono } from "hono";
import { pluginCatalogBrowse } from "@oxagen/oxagen/contracts/plugin.catalog.browse";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginCatalogBrowseRoute = new Hono<AppEnv>();

pluginCatalogBrowseRoute.post("/", async (c) => {
  const body = pluginCatalogBrowse.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginCatalogBrowse.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
