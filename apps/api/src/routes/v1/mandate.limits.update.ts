import { Hono } from "hono";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const mandateLimitsUpdateRoute = new Hono<AppEnv>();

mandateLimitsUpdateRoute.post("/", async (c) => {
  const body = mandateLimitsUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(mandateLimitsUpdate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
