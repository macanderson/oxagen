import { Hono } from "hono";
import { pluginRegistryAdd } from "@oxagen/oxagen/contracts/plugin.registry.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginRegistryAddRoute = new Hono<AppEnv>();

pluginRegistryAddRoute.post("/", async (c) => {
  const body = pluginRegistryAdd.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginRegistryAdd.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
