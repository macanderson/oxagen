import { Hono } from "hono";
import { environmentGet } from "@oxagen/oxagen/contracts/environment.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const environmentGetRoute = new Hono<AppEnv>();

environmentGetRoute.post("/", async (c) => {
  const body = environmentGet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(environmentGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});
