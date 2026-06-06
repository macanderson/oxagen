import { Hono } from "hono";
import { pluginRegistrySync } from "@oxagen/oxagen/contracts/plugin.registry.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginRegistrySyncRoute = new Hono<AppEnv>();

pluginRegistrySyncRoute.post("/", async (c) => {
  const body = pluginRegistrySync.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginRegistrySync.name, body, ctx, { surface: "api" });
  return c.json(out);
});
