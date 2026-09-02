import { Hono } from "hono";
import { pluginRegistryRemove } from "@oxagen/oxagen/contracts/plugin.registry.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginRegistryRemoveRoute = new Hono<AppEnv>();

pluginRegistryRemoveRoute.post("/", async (c) => {
  const body = pluginRegistryRemove.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginRegistryRemove.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
