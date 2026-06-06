import { Hono } from "hono";
import { pluginOrgList } from "@oxagen/oxagen/contracts/plugin.org.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginOrgListRoute = new Hono<AppEnv>();

pluginOrgListRoute.post("/", async (c) => {
  const body = pluginOrgList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginOrgList.name, body, ctx, { surface: "api" });
  return c.json(out);
});
