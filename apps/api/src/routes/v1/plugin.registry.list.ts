import { Hono } from "hono";
import { pluginRegistryList } from "@oxagen/oxagen/contracts/plugin.registry.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginRegistryListRoute = new Hono<AppEnv>();

pluginRegistryListRoute.post("/", async (c) => {
  const body = pluginRegistryList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginRegistryList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
