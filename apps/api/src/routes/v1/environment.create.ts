import { Hono } from "hono";
import { environmentCreate } from "@oxagen/oxagen/contracts/environment.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const environmentCreateRoute = new Hono<AppEnv>();

environmentCreateRoute.post("/", async (c) => {
  const body = environmentCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(environmentCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
