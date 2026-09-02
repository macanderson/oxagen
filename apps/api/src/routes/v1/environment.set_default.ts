import { Hono } from "hono";
import { environmentSetDefault } from "@oxagen/oxagen/contracts/environment.set_default";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const environmentSetDefaultRoute = new Hono<AppEnv>();

environmentSetDefaultRoute.post("/", async (c) => {
  const body = environmentSetDefault.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(environmentSetDefault.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
