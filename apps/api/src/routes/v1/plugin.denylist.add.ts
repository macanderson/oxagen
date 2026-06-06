import { Hono } from "hono";
import { pluginDenylistAdd } from "@oxagen/oxagen/contracts/plugin.denylist.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginDenylistAddRoute = new Hono<AppEnv>();

pluginDenylistAddRoute.post("/", async (c) => {
  const body = pluginDenylistAdd.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginDenylistAdd.name, body, ctx, { surface: "api" });
  return c.json(out);
});
