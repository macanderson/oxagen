import { Hono } from "hono";
import { environmentDelete } from "@oxagen/oxagen/contracts/environment.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const environmentDeleteRoute = new Hono<AppEnv>();

environmentDeleteRoute.post("/", async (c) => {
  const body = environmentDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(environmentDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
