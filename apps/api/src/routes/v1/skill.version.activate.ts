import { Hono } from "hono";
import { skillVersionActivate } from "@oxagen/oxagen/contracts/skill.version.activate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillVersionActivateRoute = new Hono<AppEnv>();

skillVersionActivateRoute.post("/", async (c) => {
  const body = skillVersionActivate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillVersionActivate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
