import { Hono } from "hono";
import { pluginCatalogGet } from "@oxagen/oxagen/contracts/plugin.catalog.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginCatalogGetRoute = new Hono<AppEnv>();

pluginCatalogGetRoute.post("/", async (c) => {
  const body = pluginCatalogGet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginCatalogGet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
