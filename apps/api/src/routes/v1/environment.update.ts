import { Hono } from "hono";
import { environmentUpdate } from "@oxagen/oxagen/contracts/environment.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const environmentUpdateRoute = new Hono<AppEnv>();

environmentUpdateRoute.post("/", async (c) => {
  const body = environmentUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(environmentUpdate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
