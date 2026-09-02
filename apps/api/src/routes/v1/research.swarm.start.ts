import { Hono } from "hono";
import { researchSwarmStart } from "@oxagen/oxagen/contracts/research.swarm.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const researchSwarmStartRoute = new Hono<AppEnv>();

researchSwarmStartRoute.post("/", async (c) => {
  const body = researchSwarmStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(researchSwarmStart.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});
