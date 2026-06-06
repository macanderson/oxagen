import { Hono } from "hono";
import { pluginDenylistRemove } from "@oxagen/oxagen/contracts/plugin.denylist.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginDenylistRemoveRoute = new Hono<AppEnv>();

pluginDenylistRemoveRoute.post("/", async (c) => {
  const body = pluginDenylistRemove.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginDenylistRemove.name, body, ctx, { surface: "api" });
  return c.json(out);
});
